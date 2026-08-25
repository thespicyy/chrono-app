/*
 * Pomodoro — moteur d'état, sans DOM ni canvas.
 *
 * Tout ce qui décide « quel mode, combien de temps, où en est-on » vit ici, en
 * fonctions pures prenant l'horloge en paramètre. C'est ce qui rend le moteur
 * testable en Node (`node tests/timer.test.js`) sans navigateur ni fenêtre : le
 * reste du code (app.js, orbit.js) ne fait que l'afficher.
 *
 * Le temps est représenté par un **horodatage de fin absolu** (`endTimestamp`),
 * jamais par un compteur décrémenté. C'est la seule représentation qui survit à
 * une fermeture de l'app, à une mise en veille de la machine ou à un décalage
 * de la boucle d'événements : on relit l'heure, on soustrait, on sait où on en
 * est. `remainingMs` n'est qu'une valeur d'affichage recalculée à chaque tick.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PomodoroTimer = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = ['focus', 'shortBreak', 'longBreak', 'chrono'];
  var MODE_LABELS = {
    focus: 'Focus', shortBreak: 'Pause courte', longBreak: 'Pause longue',
    chrono: 'Chrono'
  };

  /*
   * Le chrono compte **à l'endroit**, sans durée cible : il n'a ni fin, ni
   * enchaînement, ni place dans le cycle. Il est donc modélisé par ses propres
   * champs (`startTimestamp`, `elapsedMs`) plutôt qu'en détournant ceux du
   * minuteur — un `remainingMs` qui voudrait dire « écoulé » selon le mode
   * serait une source d'erreurs permanente.
   *
   * Comme le minuteur, il repose sur un **horodatage absolu** : fermer
   * l'application pendant qu'il tourne ne l'arrête pas, exactement comme un
   * chronomètre qu'on laisse dans sa poche.
   */
  //: Une révolution de l'anneau par minute — l'orbite devient une trotteuse.
  var CHRONO_TOUR_MS = 60000;

  function estChrono(mode) { return mode === 'chrono'; }

  /*
   * Bornes des réglages. Elles servent à deux endroits — la validation à
   * l'enregistrement et les attributs min/max des champs — donc elles sont
   * déclarées une seule fois ici, d'où l'interface les lit.
   */
  var LIMITS = {
    focusMin:                { min: 1, max: 180, def: 25,  int: true },
    shortBreakMin:           { min: 1, max: 60,  def: 5,   int: true },
    longBreakMin:            { min: 1, max: 120, def: 15,  int: true },
    sessionsBeforeLongBreak: { min: 1, max: 12,  def: 4,   int: true },
    sphereDensity:           { min: 500, max: 8000, def: 4500, int: true },
    sphereSpin:              { min: 0, max: 0.02, def: 0.004 },
    noiseAmpLarge:           { min: 0, max: 0.3,  def: 0.07 },
    noiseFreqLarge:          { min: 0, max: 0.05, def: 0.01 },
    noiseAmpDetail:          { min: 0, max: 0.5,  def: 0.2 },
    noiseFreqDetail:         { min: 0, max: 5,    def: 1.9 },
    sphereReactivity:        { min: 0, max: 0.2,  def: 0.06 },
    //: Minutes d'inactivité au bout desquelles un Focus se met en pause seul.
    idleMinutes:             { min: 1, max: 60,  def: 5,   int: true }
  };

  var FLAGS = {
    soundOn: true, autoStartNext: false, notifyOn: true,
    //: Mise en pause automatique quand l'utilisateur ne fait plus rien.
    idlePauseOn: true
  };

  /*
   * Alertes de fin de session. Le fichier est synthétisé par tools/make_sounds.py,
   * sauf « corbeau », hérité de la version Orbit et conservé pour qui l'aimait.
   * Le premier de la liste est la valeur par défaut.
   */
  var SONS = [
    { cle: 'cloche',   libelle: 'Cloche',   fichier: 'sounds/cloche.wav' },
    { cle: 'carillon', libelle: 'Carillon', fichier: 'sounds/carillon.wav' },
    { cle: 'bip',      libelle: 'Bip',      fichier: 'sounds/bip.wav' },
    { cle: 'bois',     libelle: 'Bois',     fichier: 'sounds/bois.wav' },
    { cle: 'corbeau',  libelle: 'Corbeau',  fichier: 'sounds/crow.mp3' }
  ];

  //: Réglages dont la valeur est un choix dans une liste, et non un nombre ou
  //: un interrupteur. Validés de la même façon : une valeur inconnue retombe
  //: sur la première de la liste plutôt que de laisser l'app sans son.
  var CHOIX = { soundName: SONS.map(function (s) { return s.cle; }) };

  /** Champs décrivant la sphère centrale — ceux qu'un preset enregistre. */
  var SPHERE_FIELDS = ['sphereDensity', 'sphereSpin', 'noiseAmpLarge', 'noiseFreqLarge',
                       'noiseAmpDetail', 'noiseFreqDetail', 'sphereReactivity'];

  function clampNumber(value, spec) {
    var n = spec.int ? parseInt(value, 10) : parseFloat(value);
    if (!isFinite(n)) return spec.def;
    if (n < spec.min) return spec.min;
    if (n > spec.max) return spec.max;
    return n;
  }

  function defaultSettings() {
    var s = {};
    Object.keys(LIMITS).forEach(function (key) { s[key] = LIMITS[key].def; });
    Object.keys(FLAGS).forEach(function (key) { s[key] = FLAGS[key]; });
    Object.keys(CHOIX).forEach(function (key) { s[key] = CHOIX[key][0]; });
    return s;
  }

  /** Fichier de l'alerte choisie ; celui du premier son si la clé est inconnue. */
  function soundFile(cle) {
    for (var i = 0; i < SONS.length; i++) {
      if (SONS[i].cle === cle) return SONS[i].fichier;
    }
    return SONS[0].fichier;
  }

  /**
   * Ramène n'importe quel objet (réglages relus du disque, valeurs saisies dans
   * la modale) à des réglages valides. Une valeur absente ou aberrante retombe
   * sur sa valeur par défaut plutôt que de contaminer le moteur : un
   * `focusMin` à NaN produirait un `durationMs` NaN, donc un affichage et une
   * progression NaN, et plus rien ne repartirait.
   */
  function normalizeSettings(raw) {
    var src = raw || {};
    var out = {};
    // `src[key] == null` plutôt que `key in src` : une clé présente mais à
    // `null`/`undefined` (préférences écrites par une version antérieure, fichier
    // tronqué) doit compter comme absente. Avec `in`, un `notifyOn: undefined`
    // partait dans la branche « valeur fournie » et `!!undefined` éteignait
    // silencieusement un interrupteur dont la valeur par défaut est « allumé ».
    Object.keys(LIMITS).forEach(function (key) {
      out[key] = src[key] == null ? LIMITS[key].def : clampNumber(src[key], LIMITS[key]);
    });
    Object.keys(FLAGS).forEach(function (key) {
      out[key] = src[key] == null ? FLAGS[key] : !!src[key];
    });
    Object.keys(CHOIX).forEach(function (key) {
      var valeurs = CHOIX[key];
      out[key] = valeurs.indexOf(src[key]) > -1 ? src[key] : valeurs[0];
    });
    return out;
  }

  function modeDurationMs(mode, settings) {
    if (mode === 'chrono') return 0;             // pas de cible : il monte
    if (mode === 'shortBreak') return settings.shortBreakMin * 60000;
    if (mode === 'longBreak') return settings.longBreakMin * 60000;
    return settings.focusMin * 60000;
  }

  function defaultState() {
    var settings = defaultSettings();
    var duration = modeDurationMs('focus', settings);
    return {
      version: 1,
      settings: settings,
      session: {
        mode: 'focus',
        focusCount: 0,
        running: false,
        endTimestamp: null,
        remainingMs: duration,
        durationMs: duration,
        startTimestamp: null,
        elapsedMs: 0
      }
    };
  }

  /**
   * Mode qui suit `mode` : un focus mène à une pause (longue tous les
   * `sessionsBeforeLongBreak` focus accomplis), une pause ramène au focus.
   * Renvoie le compteur de focus mis à jour avec le mode suivant.
   */
  function nextMode(mode, focusCount, settings) {
    // Le chrono ne mène nulle part : il n'appartient pas au cycle.
    if (estChrono(mode)) return { mode: mode, focusCount: focusCount };
    if (mode !== 'focus') return { mode: 'focus', focusCount: focusCount };
    var count = focusCount + 1;
    var longEvery = settings.sessionsBeforeLongBreak;
    return { mode: (count % longEvery === 0) ? 'longBreak' : 'shortBreak', focusCount: count };
  }

  /** Fait passer la session au mode suivant, en place. */
  function advance(session, settings) {
    var next = nextMode(session.mode, session.focusCount, settings);
    session.mode = next.mode;
    session.focusCount = next.focusCount;
    return session;
  }

  /**
   * Recolle l'état à l'heure réelle après une absence (app fermée, machine en
   * veille, onglet en arrière-plan). Renvoie le nombre d'intervalles franchis
   * pendant l'absence — l'appelant s'en sert pour décider s'il doit signaler
   * quelque chose.
   *
   * Le garde-fou de 500 tours évite qu'une session laissée ouverte des mois en
   * enchaînement automatique ne fasse tourner la boucle des millions de fois au
   * démarrage (une pause courte de 1 minute = 500 000 tours pour un an).
   */
  function resolveElapsed(state, now) {
    var s = state.session;
    // Un chrono n'a pas d'intervalle à franchir : son horodatage de départ
    // suffit à recalculer l'écoulé, absence comprise.
    if (estChrono(s.mode)) return 0;
    if (!s.running || !s.endTimestamp) return 0;
    var remaining = s.endTimestamp - now;
    var crossed = 0;
    var guard = 0;
    while (remaining <= 0 && guard < 500) {
      guard++;
      crossed++;
      advance(s, state.settings);
      s.durationMs = modeDurationMs(s.mode, state.settings);
      if (state.settings.autoStartNext) {
        remaining += s.durationMs;
        s.remainingMs = Math.max(0, remaining);
        s.endTimestamp = now + s.remainingMs;
      } else {
        s.running = false;
        s.endTimestamp = null;
        s.remainingMs = s.durationMs;
        break;
      }
    }
    if (s.running && s.endTimestamp) {
      s.remainingMs = Math.max(0, s.endTimestamp - now);
    }
    return crossed;
  }

  /**
   * Reconstruit un état complet à partir de ce qui a été relu du disque, en
   * comblant tout ce qui manque. Un fichier de préférences vide, tronqué ou
   * écrit par une version antérieure doit donner une app qui démarre, jamais
   * une page blanche.
   */
  function hydrate(parsed, now) {
    var base = defaultState();
    if (!parsed || typeof parsed !== 'object') return base;

    var settings = normalizeSettings(parsed.settings);
    var raw = parsed.session && typeof parsed.session === 'object' ? parsed.session : {};
    var mode = MODES.indexOf(raw.mode) > -1 ? raw.mode : 'focus';
    var duration = modeDurationMs(mode, settings);
    var focusCount = parseInt(raw.focusCount, 10);
    if (!isFinite(focusCount) || focusCount < 0) focusCount = 0;

    var endTimestamp = parseFloat(raw.endTimestamp);
    if (!isFinite(endTimestamp)) endTimestamp = null;

    var startTimestamp = parseFloat(raw.startTimestamp);
    if (!isFinite(startTimestamp)) startTimestamp = null;

    // Un chrono en marche est ancré à `startTimestamp`, un minuteur à
    // `endTimestamp` : chacun a besoin du sien pour être repris.
    var running = !!raw.running
      && (estChrono(mode) ? startTimestamp !== null : endTimestamp !== null);

    var remaining = parseFloat(raw.remainingMs);
    if (!isFinite(remaining) || remaining < 0 || remaining > duration) remaining = duration;

    var elapsed = parseFloat(raw.elapsedMs);
    if (!isFinite(elapsed) || elapsed < 0) elapsed = 0;

    var state = {
      version: 1,
      settings: settings,
      session: {
        mode: mode,
        focusCount: focusCount,
        running: running,
        endTimestamp: running ? endTimestamp : null,
        remainingMs: remaining,
        durationMs: duration,
        startTimestamp: running ? startTimestamp : null,
        elapsedMs: elapsed
      }
    };
    resolveElapsed(state, now);
    return state;
  }

  /** Ne persiste que ce qui a un sens au prochain démarrage. */
  function serialize(state) {
    var s = state.session;
    return {
      version: 1,
      settings: state.settings,
      session: {
        mode: s.mode,
        focusCount: s.focusCount,
        running: s.running,
        endTimestamp: s.endTimestamp,
        remainingMs: s.remainingMs,
        startTimestamp: s.startTimestamp,
        elapsedMs: s.elapsedMs
      }
    };
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  function start(state, now) {
    var s = state.session;
    if (s.running) return state;
    if (estChrono(s.mode)) {
      // Le chrono repart de ce qu'il avait accumulé : on ne retient que
      // l'instant de reprise, l'écoulé se recalcule à la lecture.
      s.startTimestamp = now;
      s.running = true;
      return state;
    }
    if (s.remainingMs <= 0) s.remainingMs = s.durationMs;
    s.endTimestamp = now + s.remainingMs;
    s.running = true;
    return state;
  }

  function pause(state, now) {
    var s = state.session;
    if (!s.running) return state;
    if (estChrono(s.mode)) {
      s.elapsedMs = elapsedAt(state, now);
      s.startTimestamp = null;
      s.running = false;
      return state;
    }
    s.remainingMs = Math.max(0, s.endTimestamp - now);
    s.running = false;
    s.endTimestamp = null;
    return state;
  }

  function toggle(state, now) {
    return state.session.running ? pause(state, now) : start(state, now);
  }

  /** Remet l'intervalle courant à zéro, sans changer de mode ni de compteur. */
  function reset(state) {
    var s = state.session;
    s.running = false;
    s.endTimestamp = null;
    s.startTimestamp = null;
    s.elapsedMs = 0;
    s.durationMs = modeDurationMs(s.mode, state.settings);
    s.remainingMs = s.durationMs;
    return state;
  }

  /**
   * Clôt l'intervalle courant et enchaîne. `autoStartNext` décide si le suivant
   * démarre seul ou attend un clic.
   */
  function complete(state, now) {
    var s = state.session;
    // Un chrono n'a pas d'intervalle à clore : « Passer » n'y a aucun sens, et
    // le bouton est d'ailleurs désactivé. Garde-fou pour le cas où on
    // l'appellerait quand même (raccourci clavier, appel programmé).
    if (estChrono(s.mode)) return state;
    advance(s, state.settings);
    s.durationMs = modeDurationMs(s.mode, state.settings);
    s.remainingMs = s.durationMs;
    if (state.settings.autoStartNext) {
      s.running = true;
      s.endTimestamp = now + s.durationMs;
    } else {
      s.running = false;
      s.endTimestamp = null;
    }
    return state;
  }

  // ── Mise en pause sur inactivité ────────────────────────────────────────

  /**
   * Faut-il mettre la session en pause faute d'activité ?
   *
   * **Uniquement pendant un Focus.** Une pause doit continuer de s'écouler quand
   * on quitte son bureau — c'est même exactement ce qu'on attend d'elle. La
   * suspendre parce que l'utilisateur s'est éloigné reviendrait à ne jamais la
   * voir se terminer.
   *
   * `idleSeconds` vient de Windows (souris **et** clavier), pas de la page : un
   * moteur web ne voit rien de ce qui se passe hors de sa fenêtre.
   */
  function shouldAutoPause(state, idleSeconds) {
    if (!state.settings.idlePauseOn) return false;
    var s = state.session;
    if (!s.running || s.mode !== 'focus') return false;
    if (!isFinite(idleSeconds) || idleSeconds < 0) return false;
    return idleSeconds >= state.settings.idleMinutes * 60;
  }

  /**
   * Met en pause **et rend le temps compté pendant l'absence**.
   *
   * Sans cette restitution, la fonction créditerait précisément les minutes
   * qu'elle est censée écarter : on détecte l'inactivité cinq minutes après
   * qu'elle a commencé, et ces cinq minutes auraient compté comme du travail. On
   * remet donc le compteur là où il était au dernier geste — la session reprend
   * exactement où elle s'était arrêtée dans les faits.
   *
   * La restitution est bornée par le temps réellement écoulé dans l'intervalle :
   * une machine réveillée après des heures de veille ne doit pas rendre plus de
   * temps que l'intervalle n'en comptait.
   */
  function autoPause(state, now, idleSeconds) {
    pause(state, now);
    var s = state.session;
    var ecoule = s.durationMs - s.remainingMs;
    var rendu = Math.min(Math.max(0, idleSeconds) * 1000, Math.max(0, ecoule));
    s.remainingMs = Math.min(s.durationMs, s.remainingMs + rendu);
    return state;
  }

  /** Bascule vers un mode choisi à la main : l'intervalle repart à zéro, à l'arrêt. */
  function selectMode(state, mode) {
    if (MODES.indexOf(mode) === -1) return state;
    var s = state.session;
    s.mode = mode;
    s.running = false;
    s.endTimestamp = null;
    s.startTimestamp = null;
    s.elapsedMs = 0;
    s.durationMs = modeDurationMs(mode, state.settings);
    s.remainingMs = s.durationMs;
    return state;
  }

  /**
   * Applique de nouveaux réglages. Une session **en cours** garde sa durée :
   * changer « Focus = 50 min » pendant un focus de 25 min entamé ne doit pas
   * rallonger ni tronquer l'intervalle sous les pieds de l'utilisateur ; le
   * nouveau réglage prend effet à l'intervalle suivant.
   */
  function applySettings(state, raw) {
    state.settings = normalizeSettings(raw);
    var s = state.session;
    if (!s.running) {
      s.durationMs = modeDurationMs(s.mode, state.settings);
      s.remainingMs = s.durationMs;
    }
    return state;
  }

  // ── Lecture pour l'affichage ────────────────────────────────────────────

  /**
   * Millisecondes restantes à l'instant `now`. Recalculé depuis `endTimestamp`
   * plutôt que lu dans `remainingMs` : ce dernier n'est rafraîchi qu'une fois
   * par seconde, l'animation à 60 fps a besoin d'une valeur continue.
   */
  function remainingAt(state, now) {
    var s = state.session;
    if (s.running && s.endTimestamp) return Math.max(0, s.endTimestamp - now);
    return Math.max(0, s.remainingMs);
  }

  /**
   * Millisecondes écoulées depuis le départ du chrono, reprises comprises.
   *
   * Recalculé depuis `startTimestamp` plutôt que compté : c'est ce qui permet au
   * chrono de continuer à tourner pendant que l'application est fermée, comme un
   * chronomètre qu'on laisse dans sa poche.
   */
  function elapsedAt(state, now) {
    var s = state.session;
    var base = Math.max(0, s.elapsedMs || 0);
    if (s.running && s.startTimestamp) return base + Math.max(0, now - s.startTimestamp);
    return base;
  }

  /** Ce que le décompte doit afficher : restant pour le minuteur, écoulé pour le chrono. */
  function displayMs(state, now) {
    return estChrono(state.session.mode) ? elapsedAt(state, now) : remainingAt(state, now);
  }

  /**
   * Avancement dans [0,1] de l'intervalle courant.
   *
   * Le chrono n'a pas de cible : l'anneau y fait **une révolution par minute**,
   * ce qui en fait une trotteuse. La scène continue ainsi de montrer le temps
   * qui passe au lieu de rester figée.
   */
  function progressAt(state, now) {
    if (estChrono(state.session.mode)) {
      return (elapsedAt(state, now) % CHRONO_TOUR_MS) / CHRONO_TOUR_MS;
    }
    var duration = state.session.durationMs;
    if (!duration) return 0;
    var p = 1 - remainingAt(state, now) / duration;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /**
   * « 01:30 » — les secondes sont **tronquées**, pas arrondies.
   *
   * C'est l'inverse de `formatMs`, et les deux sont justes chacun de leur côté :
   * un décompte doit afficher sa durée pleine à la seconde zéro et ne pas
   * sauter le « 00:01 », donc il arrondit au supérieur ; un temps écoulé doit
   * afficher « 00:00 » tant que la première seconde n'est pas passée, comme
   * n'importe quel chronomètre.
   */
  function formatElapsed(ms) {
    var totalSec = Math.floor(Math.max(0, ms) / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var sec = totalSec % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(sec);
    return pad2(m) + ':' + pad2(sec);
  }

  /** « 25:00 » — les secondes sont arrondies au supérieur pour que le compte
   *  affiche la durée pleine à la seconde 0 et ne saute pas le « 00:01 ». */
  function formatMs(ms) {
    var totalSec = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var sec = totalSec % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(sec);
    return pad2(m) + ':' + pad2(sec);
  }

  /** Nombre de pastilles pleines du cycle en cours. Aucune hors du cycle. */
  function filledDots(state) {
    if (estChrono(state.session.mode)) return 0;
    var cycle = state.settings.sessionsBeforeLongBreak;
    if (state.session.mode === 'longBreak') return cycle;
    return state.session.focusCount % cycle;
  }

  return {
    MODES: MODES,
    MODE_LABELS: MODE_LABELS,
    CHRONO_TOUR_MS: CHRONO_TOUR_MS,
    isChrono: estChrono,
    elapsedAt: elapsedAt,
    displayMs: displayMs,
    LIMITS: LIMITS,
    SONS: SONS,
    soundFile: soundFile,
    SPHERE_FIELDS: SPHERE_FIELDS,
    defaultSettings: defaultSettings,
    defaultState: defaultState,
    normalizeSettings: normalizeSettings,
    modeDurationMs: modeDurationMs,
    nextMode: nextMode,
    advance: advance,
    resolveElapsed: resolveElapsed,
    hydrate: hydrate,
    serialize: serialize,
    start: start,
    pause: pause,
    toggle: toggle,
    reset: reset,
    complete: complete,
    selectMode: selectMode,
    shouldAutoPause: shouldAutoPause,
    autoPause: autoPause,
    applySettings: applySettings,
    remainingAt: remainingAt,
    progressAt: progressAt,
    formatMs: formatMs,
    formatElapsed: formatElapsed,
    filledDots: filledDots
  };
}));
