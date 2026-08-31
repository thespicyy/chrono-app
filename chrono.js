/*
 * Chrono — câblage de la PWA.
 *
 * Le calcul du temps n'est pas ici : il vient de `timer.js`, le moteur de
 * l'application de bureau, copié tel quel au moment de la construction. Cette
 * page en utilise deux modes — le chrono, qui compte à l'endroit, et le
 * minuteur, qui compte à rebours — et hérite ainsi de ses garanties :
 * horodatage absolu, relecture défensive, et les 68 tests qui les couvrent.
 * Réécrire un compteur ici aurait été plus court et moins sûr.
 *
 * LE MINUTEUR N'A DEMANDÉ AUCUN AJOUT AU MOTEUR. Le mode `focus` compte déjà à
 * rebours vers un horodatage de fin, sa durée venant du réglage `focusMin` : le
 * minuteur de cette page est ce mode, avec la durée choisie par une tape. Rien
 * de ce qui est partagé avec l'application de bureau n'a bougé — et donc rien
 * de ce que ses tests protègent.
 */
(function () {
  'use strict';

  var T = window.PomodoroTimer;
  var CLE = 'chrono_pwa';

  function logErreur(contexte, err) {
    console.error('[Chrono] ' + contexte, err);
  }

  // ── État ────────────────────────────────────────────────────────────────
  //
  // Ici `localStorage` convient, contrairement à l'application de bureau : la
  // page est servie depuis une origine stable, pas depuis un port éphémère.

  function lire() {
    try {
      var brut = localStorage.getItem(CLE);
      return brut ? JSON.parse(brut) : null;
    } catch (err) {
      logErreur('lire : JSON illisible, retour à zéro', err);
      return null;
    }
  }

  function ecrire() {
    try {
      localStorage.setItem(CLE, JSON.stringify(T.serialize(state)));
    } catch (err) {
      logErreur('ecrire : localStorage indisponible', err);
    }
  }

  //: Le minuteur EST le mode `focus` du moteur : même décompte, même
  //: horodatage de fin, même durée tirée de `focusMin`.
  var MINUTEUR = 'focus';

  /*
   * Trois vues, dont une seule ne concerne pas le moteur.
   *
   * L'horloge n'a rien à compter : elle lit l'heure du système. Elle est donc
   * gardée **hors** de `state.session.mode`, qui n'accepte que les modes connus
   * du moteur — y glisser « horloge » serait silencieusement ignoré par
   * `selectMode`, et l'application resterait sur la vue précédente sans que
   * rien ne le signale.
   *
   * Conséquence voulue : un minuteur lancé continue de tourner pendant qu'on
   * regarde l'heure, et sonne quand même. La vue décide de ce qui s'affiche,
   * pas de ce qui s'exécute.
   */
  var VUES = ['chrono', 'minuteur', 'horloge'];
  var CLE_VUE = 'chrono_pwa_vue';

  //: Durées toutes prêtes, par tranches de trente minutes.
  var DUREES = [30, 60, 90, 120, 150, 180];

  //: Pas des boutons de réglage, en minutes. Une heure d'un côté, cinq minutes
  //: de l'autre : c'est le découpage de l'affichage (HH:MM), et chaque bouton
  //: agit donc sur la carte qu'il encadre.
  var PAS_HEURE = 60;
  var PAS_MINUTE = 5;

  //: Bornes de la durée, en minutes. Le plafond n'est pas choisi ici : c'est
  //: celui du réglage `focusMin` du moteur, où la durée est rangée (cf.
  //: `dureeMinutes`). Trois heures, ce qui couvre la plus longue tranche.
  var DUREE_MIN = 5;
  var DUREE_MAX = T.LIMITS.focusMin.max;

  var stocke = lire();
  var state = T.hydrate(stocke, Date.now());

  // Le mode retenu doit venir de ce qui était **stocké**, pas de l'état
  // hydraté : le moteur, faute de données, rend un état en mode `focus` — qui
  // se trouve être le mode du minuteur. Interroger l'état hydraté ferait donc
  // démarrer une installation neuve en minuteur, alors que cette page est
  // d'abord un chronomètre. Un mode inconnu (pause courte ou longue héritée de
  // l'application de bureau) retombe lui aussi sur le chrono.
  var modeStocke = (stocke && stocke.session) ? stocke.session.mode : null;
  if (modeStocke !== MINUTEUR && !T.isChrono(modeStocke)) {
    T.selectMode(state, 'chrono');
  }

  var vue = null;
  try { vue = localStorage.getItem(CLE_VUE); } catch (err) { logErreur('lire la vue', err); }
  // Une version antérieure ne connaissait pas les vues : la déduire du mode
  // retrouvé évite de repartir sur le chronomètre alors qu'on avait laissé un
  // minuteur réglé.
  if (VUES.indexOf(vue) === -1) vue = (modeStocke === MINUTEUR) ? 'minuteur' : 'chrono';

  function ecrireVue() {
    try { localStorage.setItem(CLE_VUE, vue); } catch (err) { logErreur('écrire la vue', err); }
  }

  // Première ouverture : la durée par défaut du moteur est de 25 minutes, qui
  // ne figure dans aucune des tranches proposées — l'application s'ouvrirait
  // sur une valeur qu'elle ne sait pas offrir. On pose la première tranche.
  // Écrit dans les réglages plutôt que par `poserDuree`, appelée trop tôt ici :
  // l'interface n'existe pas encore.
  if (!stocke) {
    state.settings.focusMin = DUREES[0];
    T.reset(state);
  }

  function enMinuteur() { return vue === 'minuteur'; }
  function enHorloge() { return vue === 'horloge'; }

  // ── Durée du minuteur ───────────────────────────────────────────────────

  /**
   * La durée voulue est celle du réglage `focusMin` du moteur.
   *
   * Une première version la gardait à côté, dans `localStorage`, pour
   * s'affranchir de ses bornes. C'était une erreur, et pas une petite : à la
   * relecture, le moteur **plafonne le temps restant à la durée tirée de ses
   * réglages**. Une durée de 1 h 40 rangée ailleurs revenait donc à 25 minutes
   * après un rechargement — la valeur par défaut. Ranger la durée là où le
   * moteur la lit fait disparaître le problème au lieu de le contourner, et
   * ses bornes (1 à 180 minutes) couvrent exactement les tranches proposées.
   */
  function dureeMinutes() {
    return state.settings.focusMin;
  }

  /** Pose une durée, en minutes, et rearme l'intervalle. */
  function poserDuree(minutes) {
    if (minutes < DUREE_MIN) minutes = DUREE_MIN;
    if (minutes > DUREE_MAX) minutes = DUREE_MAX;
    // On repart des réglages courants pour n'en changer qu'un : `applySettings`
    // ramène tout objet à des réglages complets, et lui passer une seule clé
    // ferait retomber toutes les autres sur leur valeur par défaut.
    var reglages = {};
    Object.keys(state.settings).forEach(function (cle) {
      reglages[cle] = state.settings[cle];
    });
    reglages.focusMin = minutes;
    T.applySettings(state, reglages);
    T.reset(state);
    taire();
    ecrire();
    majDurees();
    majVolets(T.displayMs(state, Date.now()), false);
    majBouton();
    reveillerBarre();
  }

  /** Change la durée voulue. `delta` est en minutes, et peut être négatif. */
  function ajusterDuree(delta) {
    if (!enMinuteur() || state.session.running) return;
    poserDuree(dureeMinutes() + delta);
  }

  function choisirDuree(minutes) {
    if (!enMinuteur()) return;
    poserDuree(minutes);
  }

  // ── Éléments ────────────────────────────────────────────────────────────
  var el = {
    scene:      document.getElementById('scene'),
    cartes:     document.getElementById('flip-cartes'),
    barre:      document.getElementById('barre'),
    startPause: document.getElementById('startpause'),
    icone:      document.getElementById('icone-forme'),
    reset:      document.getElementById('reset'),
    synchro: document.getElementById('synchro'),
    progression: document.getElementById('progression'),
    mode:       document.getElementById('mode'),
    iconeMode:  document.getElementById('icone-mode-forme'),
    durees:     document.getElementById('durees')
  };

  var ICONE_LECTURE = 'M7 4l13 8-13 8z';
  var ICONE_PAUSE = 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z';

  // L'icône du bouton de mode montre **ce vers quoi il bascule**, pas l'état
  // courant : un bouton qui affiche ce qu'on a déjà n'apprend rien.
  var ICONE_VERS_MINUTEUR = 'M6 2h12M6 22h12M6 2c0 5 12 5 12 0M6 22c0-5 12-5 12 0';
  var ICONE_VERS_CHRONO = 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z';
  //: Un cadran à aiguilles, distinct du chronomètre : celui-ci porte un
  //: bouton-poussoir sur le dessus, celle-là n'en a pas.
  var ICONE_VERS_HORLOGE = 'M12 8v4l2.5 1.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3V1' + 'M9.5 1h5';

  // ── Horloge à volets ────────────────────────────────────────────────────
  //
  // Quatre couches par carte : deux moitiés fixes et deux rabats. Le rabat haut
  // tombe en montrant l'ancien chiffre et découvre le nouveau ; le rabat bas se
  // relève en apportant le nouveau et recouvre l'ancien. Une seule couche
  // suffirait à animer quelque chose, mais on verrait une carte tourner sur
  // elle-même, pas un volet tomber.

  function construireCarte() {
    var carte = document.createElement('div');
    carte.className = 'flip-carte';
    var couches = {};
    [['fc-moitie fc-haut', 'haut'], ['fc-moitie fc-bas', 'bas'],
     ['fc-rabat fc-rabat-haut', 'rabatHaut'], ['fc-rabat fc-rabat-bas', 'rabatBas']]
      .forEach(function (paire) {
        var couche = document.createElement('div');
        couche.className = paire[0];
        var texte = document.createElement('div');
        texte.className = 'fc-txt';
        texte.textContent = '00';
        couche.appendChild(texte);
        carte.appendChild(couche);
        couches[paire[1]] = texte;
      });
    var volet = { racine: carte, couches: couches, valeur: '00' };
    // Le retour au repos est déclenché par la fin de l'animation, pas par une
    // minuterie : une animation interrompue — onglet masqué, appareil chargé —
    // laisserait sinon la carte figée à mi-bascule.
    carte.querySelector('.fc-rabat-bas').addEventListener('animationend', function () {
      couches.bas.textContent = volet.valeur;
      carte.classList.remove('tourne');
    });
    return volet;
  }

  // Deux volets seulement : heures et minutes. Un chronomètre posé sur un
  // bureau se lit d'un coup d'œil, et une carte des secondes qui bascule sans
  // arrêt tire l'œil en permanence — c'est l'inverse de ce qu'on lui demande.
  var volets = [construireCarte(), construireCarte()];
  // Les cartes sont posées plus bas par `encadrer`, avec leurs boutons de
  // réglage : les ajouter ici les mettrait deux fois dans la rangée.

  function poserVolet(volet, valeur, anime) {
    if (valeur === volet.valeur) return;
    var ancienne = volet.valeur;
    volet.valeur = valeur;
    volet.couches.haut.textContent = valeur;
    volet.couches.rabatHaut.textContent = ancienne;
    volet.couches.rabatBas.textContent = valeur;
    if (!anime) {
      // Remise à zéro, ou premier affichage au chargement : la valeur change
      // d'un coup. Faire basculer les deux cartes à la fois donnerait un effet
      // de machine à sous, pas d'horloge.
      volet.couches.bas.textContent = valeur;
      volet.racine.classList.remove('tourne');
      return;
    }
    volet.couches.bas.textContent = ancienne;
    volet.racine.classList.remove('tourne');
    void volet.racine.offsetWidth;   // force le navigateur à rejouer l'animation
    volet.racine.classList.add('tourne');
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /**
   * Pose les deux volets. Le découpage dépend du mode, et ce n'est pas un
   * caprice :
   *
   * Les deux modes lisent **HH:MM**. Les durées du minuteur se comptent en
   * demi-heures, et une carte des secondes qui bascule sans arrêt tirerait
   * l'œil sur un appareil qu'on regarde sans le toucher.
   */
  function majVolets(ms, anime) {
    var haut, bas;
    if (enHorloge()) {
      // L'heure du système, pas une durée : rien à arrondir.
      var maintenant = new Date();
      haut = maintenant.getHours();
      bas = maintenant.getMinutes();
    } else {
      // Arrondi au **supérieur** pour le décompte, comme `formatMs` du moteur :
      // la durée pleine s'affiche à l'instant du départ, et la dernière minute
      // se lit « 00:01 » jusqu'à l'échéance. Tronquer afficherait « 00:00 »
      // pendant toute la dernière minute — un minuteur terminé avant l'heure.
      var minutes = enMinuteur()
        ? Math.ceil(Math.max(0, ms) / 60000)
        : Math.floor(Math.max(0, ms) / 60000);
      haut = Math.floor(minutes / 60);
      bas = minutes % 60;
    }
    poserVolet(volets[0], pad2(haut), anime);
    poserVolet(volets[1], pad2(bas), anime);
  }

  // ── Écran allumé ────────────────────────────────────────────────────────
  //
  // SANS CECI, TOUT L'USAGE TOMBE : un appareil posé sur un bureau éteint son
  // écran au bout de quelques dizaines de secondes, et le chronomètre qu'on
  // voulait garder sous les yeux disparaît.
  //
  // Le verrou est **perdu** dès que la page passe en arrière-plan — c'est le
  // système qui le reprend, pas nous. Il faut donc le redemander au retour, ce
  // que fait l'écouteur de visibilité plus bas. Il n'existe qu'en contexte
  // sécurisé : en HTTPS ou sur localhost, jamais sur un simple `file://`.

  var verrouEcran = null;

  function garderEcranAllume() {
    // En horloge, l'écran reste allumé sans qu'on ait rien lancé : c'est
    // précisément l'usage — un appareil posé qu'on regarde sans le toucher.
    if (!('wakeLock' in navigator) || verrouEcran) return;
    if (!state.session.running && !enHorloge()) return;
    navigator.wakeLock.request('screen').then(function (verrou) {
      verrouEcran = verrou;
      verrou.addEventListener('release', function () { verrouEcran = null; });
    }).catch(function (err) {
      // Refus courant et sans gravité : batterie faible, onglet en arrière-plan,
      // navigateur qui ne l'implémente pas. Le chronomètre marche quand même.
      logErreur('garderEcranAllume : verrou refusé', err);
    });
  }

  function relacherEcran() {
    if (!verrouEcran) return;
    var verrou = verrouEcran;
    verrouEcran = null;
    try { verrou.release(); } catch (err) { logErreur('relacherEcran', err); }
  }

  // ── Alerte de fin de minuteur ───────────────────────────────────────────
  //
  // Le son est **synthétisé**, pas téléchargé : trois brèves notes construites
  // à la volée. Rien à embarquer dans le cache hors ligne, rien à charger, et
  // pas de question de licence — le même parti pris que les alertes de
  // l'application de bureau.
  //
  // LE CONTEXTE AUDIO DOIT ÊTRE OUVERT PAR UN GESTE. Les navigateurs mobiles
  // refusent de laisser une page émettre un son sans que l'utilisateur ait
  // touché l'écran ; un contexte créé au chargement naît « suspendu » et reste
  // muet. Il est donc réveillé à chaque tape, bien avant d'en avoir besoin :
  // au moment où le minuteur arrive à zéro, plus personne ne touche l'écran.

  var contexteAudio = null;

  function reveillerAudio() {
    try {
      if (!contexteAudio) {
        var Contexte = window.AudioContext || window.webkitAudioContext;
        if (!Contexte) return;
        contexteAudio = new Contexte();
      }
      if (contexteAudio.state === 'suspended') contexteAudio.resume();
    } catch (err) {
      logErreur('reveillerAudio : audio indisponible', err);
    }
  }

  function sonnerie() {
    reveillerAudio();
    if (!contexteAudio) return;
    try {
      var debut = contexteAudio.currentTime;
      [0, 0.45, 0.9].forEach(function (retard) {
        var oscillateur = contexteAudio.createOscillator();
        var volume = contexteAudio.createGain();
        oscillateur.type = 'sine';
        oscillateur.frequency.value = 880;
        // Attaque courte mais pas nulle : un saut net produit un claquement.
        volume.gain.setValueAtTime(0.0001, debut + retard);
        volume.gain.exponentialRampToValueAtTime(0.3, debut + retard + 0.012);
        volume.gain.exponentialRampToValueAtTime(0.0001, debut + retard + 0.34);
        oscillateur.connect(volume);
        volume.connect(contexteAudio.destination);
        oscillateur.start(debut + retard);
        oscillateur.stop(debut + retard + 0.4);
      });
    } catch (err) {
      logErreur('sonnerie', err);
    }
  }

  function vibrer() {
    try {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    } catch (err) {
      logErreur('vibrer', err);
    }
  }

  function taire() { document.body.classList.remove('sonne'); }

  /** Le minuteur est arrivé à zéro. */
  function terminer(maintenant) {
    // `pause` fige le restant à zéro et libère l'horodatage de fin. Un
    // `start` ultérieur repart alors de la durée pleine — c'est le moteur qui
    // le prévoit, pas un cas particulier ajouté ici.
    T.pause(state, maintenant);
    ecrire();
    relacherEcran();
    // Le temps est déjà passé : la question ne peut rien perturber.
    proposerAuSuivi(maintenant, state.session.durationMs);
    document.body.classList.add('sonne');
    sonnerie();
    vibrer();
    majDurees();
    reveillerBarre();
  }

  // ── Effacement des commandes ────────────────────────────────────────────
  var DELAI_EFFACEMENT_MS = 4000;
  var minuterieBarre = null;

  function reveillerBarre() {
    el.barre.classList.remove('effacee');
    document.body.classList.remove('epure');
    if (minuterieBarre) clearTimeout(minuterieBarre);
    // Les commandes s'effacent quand il n'y a plus rien à décider : pendant un
    // décompte, ou devant une horloge. À l'arrêt d'un chrono, elles sont la
    // seule chose à faire sur cette page.
    if (!state.session.running && !enHorloge()) return;
    minuterieBarre = setTimeout(function () {
      el.barre.classList.add('effacee');
      // Les commandes cèdent la place : les chiffres prennent tout ce qu'elles
      // occupaient. C'est le moment où l'appareil cesse d'être une application
      // et redevient un cadran posé sur un bureau.
      document.body.classList.add('epure');
    }, DELAI_EFFACEMENT_MS);
  }

  // ── Affichage ───────────────────────────────────────────────────────────
  function majBouton() {
    var enCours = state.session.running;
    el.icone.setAttribute('d', enCours ? ICONE_PAUSE : ICONE_LECTURE);
    var maintenant = Date.now();
    // Le titre porte les secondes dans les deux modes : il sert de repli quand
    // la page tourne dans un onglet, où les volets ne se voient pas.
    if (enHorloge()) {
      var h = new Date();
      document.title = pad2(h.getHours()) + ':' + pad2(h.getMinutes()) + ' — Horloge';
    } else {
      document.title = enMinuteur()
        ? T.formatMs(T.remainingAt(state, maintenant)) + ' — Minuteur'
        : T.formatElapsed(T.displayMs(state, maintenant)) + ' — Chrono';
    }
  }

  //: Ce que chaque vue annonce, et vers quoi elle bascule.
  var SUIVANTE = {
    chrono:   { icone: ICONE_VERS_MINUTEUR, dit: 'Passer au minuteur' },
    minuteur: { icone: ICONE_VERS_HORLOGE,  dit: 'Passer à l’horloge' },
    horloge:  { icone: ICONE_VERS_CHRONO,   dit: 'Passer au chronomètre' }
  };

  function majMode() {
    // L'icône montre **ce vers quoi on bascule** : un bouton qui affiche
    // l'état courant n'apprend rien à qui le regarde.
    var suivante = SUIVANTE[vue];
    el.iconeMode.setAttribute('d', suivante.icone);
    el.mode.setAttribute('aria-label', suivante.dit);
    document.body.classList.toggle('minuteur', enMinuteur());
    document.body.classList.toggle('horloge', enHorloge());
    majDurees();
  }

  /** « 30 min », « 1 h », « 1 h 30 » — comme on le dirait à voix haute. */
  function libelleDuree(minutes) {
    var heures = Math.floor(minutes / 60);
    var reste = minutes % 60;
    if (!heures) return reste + ' min';
    return heures + ' h' + (reste ? ' ' + reste : '');
  }

  function construireDurees() {
    DUREES.forEach(function (minutes) {
      var bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'duree';
      bouton.textContent = libelleDuree(minutes);
      // La valeur est portée par l'attribut, pas relue dans le libellé : « 1 h 30 »
      // ne se relit pas en nombre de minutes.
      bouton.setAttribute('data-minutes', String(minutes));
      bouton.addEventListener('click', function (e) {
        e.stopPropagation();
        choisirDuree(minutes);
      });
      el.durees.appendChild(bouton);
    });
  }

  function majDurees() {
    // À l'arrêt seulement : proposer de changer la durée d'un décompte en
    // cours poserait la question de ce qu'il advient du temps déjà écoulé.
    var visibles = enMinuteur() && !state.session.running;
    el.durees.hidden = !visibles;
    // La classe sert au décalage de l'horloge : la rangée est en position fixe
    // et viendrait sinon recouvrir les chiffres, qui sont centrés sur la scène.
    document.body.classList.toggle('durees-visibles', visibles);
    // Même condition, autre usage : elle fait paraître les boutons de réglage.
    document.body.classList.toggle('reglable', visibles);
    // Une pastille n'est marquée que si la durée voulue lui correspond
    // exactement : après un réglage à 3 min 30, aucune ne doit paraître
    // choisie, sans quoi la rangée mentirait sur l'état.
    var choisie = dureeMinutes();
    Array.prototype.forEach.call(el.durees.children, function (bouton) {
      var actif = parseInt(bouton.getAttribute('data-minutes'), 10) === choisie;
      bouton.classList.toggle('choisie', actif);
      bouton.setAttribute('aria-pressed', actif ? 'true' : 'false');
    });
  }

  function tick() {
    var maintenant = Date.now();
    // La fin est constatée ici, et non programmée par une minuterie : une
    // minuterie de plusieurs minutes est bridée en arrière-plan, et l'appareil
    // peut se mettre en veille entre-temps. L'horodatage de fin, lui, reste
    // vrai quoi qu'il arrive à la page.
    // Sur le **mode du moteur**, pas sur la vue : un minuteur lancé doit sonner
    // même si on regarde l'heure entre-temps.
    if (state.session.mode === MINUTEUR && state.session.running
        && T.remainingAt(state, maintenant) <= 0) {
      terminer(maintenant);
    }
    majVolets(T.displayMs(state, maintenant), true);
    majBouton();
  }

  // ── Pont vers le suivi du temps ─────────────────────────────────────────
  //
  // Le suivi est un module à part, chargé avant celui-ci. S'il manquait — un
  // fichier oublié à la construction — le chronomètre doit continuer de
  // fonctionner : c'est un supplément, pas une dépendance.

  function proposerAuSuivi(fin, dureeMs) {
    if (!window.SuiviUI) return;
    try {
      var debut = debutSession || (fin - dureeMs);
      window.SuiviUI.proposer(debut, dureeMs);
    } catch (err) {
      logErreur('proposerAuSuivi', err);
    }
    debutSession = null;
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  function basculer() {
    taire();
    // Une horloge n'a ni départ ni pause : la tape n'y sert qu'à faire
    // reparaître les commandes, ce dont `reveillerBarre` se charge déjà.
    if (enHorloge()) { reveillerBarre(); return; }
    // Le geste qui démarre est aussi celui qui ouvre le contexte audio : au
    // moment où le minuteur sonnera, plus personne ne touchera l'écran.
    reveillerAudio();
    if (!state.session.running && !debutSession) debutSession = Date.now();
    T.toggle(state, Date.now());
    ecrire();
    majDurees();
    majVolets(T.displayMs(state, Date.now()), false);
    majBouton();
    reveillerBarre();
    if (state.session.running) garderEcranAllume(); else relacherEcran();
  }

  function remettreAZero() {
    taire();
    if (enHorloge()) return;
    // Avant d'effacer : c'est le seul instant où le temps écoulé est encore
    // connu, et c'est justement ce geste qui clôt une session de travail.
    if (!enMinuteur()) {
      proposerAuSuivi(Date.now(), T.elapsedAt(state, Date.now()));
    }
    T.reset(state);
    ecrire();
    relacherEcran();
    // Pas « zéro » : en minuteur, la remise à zéro repose la durée choisie.
    majVolets(T.displayMs(state, Date.now()), false);
    majDurees();
    majBouton();
    reveillerBarre();
  }

  function basculerMode() {
    taire();
    vue = VUES[(VUES.indexOf(vue) + 1) % VUES.length];
    ecrireVue();
    // L'horloge ne touche pas au moteur : ce qui tournait continue de tourner,
    // et se retrouve tel quel au retour.
    if (!enHorloge()) T.selectMode(state, enMinuteur() ? MINUTEUR : 'chrono');
    // Rien à reposer : `selectMode` tire la durée des réglages, et c'est
    // désormais là que vit la durée voulue.
    ecrire();
    majMode();
    majVolets(T.displayMs(state, Date.now()), false);
    majBouton();
    reveillerBarre();
    // Une horloge de bureau doit rester allumée sans qu'on ait rien lancé.
    if (enHorloge() || state.session.running) garderEcranAllume();
    else relacherEcran();
  }


  function basculerPleinEcran() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch (err) {
      logErreur('basculerPleinEcran : refusé par le navigateur', err);
    }
  }

  // ── Boutons de réglage ──────────────────────────────────────────────────
  //
  // Un « − » à gauche de chaque carte et un « + » à droite, portant en toutes
  // lettres ce qu'ils font : « +1 h », « +5 min ». La version précédente
  // divisait chaque carte en deux moitiés sensibles, sans rien pour le dire —
  // c'était illisible. Un bouton doit se voir et s'annoncer.
  //
  // L'appui prolongé répète en accélérant : passer de 30 minutes à 3 heures
  // sans cela demanderait trente-six tapes.

  var PREMIER_DELAI_MS = 420;
  var REPETITION_MS = 110;
  var repetition = null;

  //: Instant où la session en cours a commencé, pour l'horodater au journal du
  //: suivi. `startTimestamp` du moteur ne convient pas : il est remis à chaque
  //: reprise après une pause, et vaut `null` pour un minuteur.
  var debutSession = null;

  function arreterRepetition() {
    if (repetition === null) return;
    clearTimeout(repetition);
    clearInterval(repetition);
    repetition = null;
  }

  function demarrerRepetition(delta) {
    arreterRepetition();
    ajusterDuree(delta);
    repetition = setTimeout(function () {
      repetition = setInterval(function () { ajusterDuree(delta); },
                               REPETITION_MS);
    }, PREMIER_DELAI_MS);
  }

  function creerBoutonPas(libelle, delta, description) {
    var bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.className = 'pas';
    bouton.textContent = libelle;
    bouton.setAttribute('aria-label', description);
    // Le bouton est dans la scène, dont la tape démarre le décompte : sans
    // arrêter la propagation, chaque réglage lancerait le minuteur.
    bouton.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      demarrerRepetition(delta);
      try { bouton.setPointerCapture(e.pointerId); } catch (err) { /* sans gravité */ }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (evenement) {
      bouton.addEventListener(evenement, arreterRepetition);
    });
    bouton.addEventListener('click', function (e) { e.stopPropagation(); });
    return bouton;
  }

  /**
   * Encadre chaque carte de ses deux boutons.
   *
   * Les boutons sont **de part et d'autre** de la carte, et non au-dessus et
   * au-dessous : la hauteur est la dimension rare ici — c'est elle qui borne la
   * taille des chiffres — alors que la largeur est en excédent, la rangée
   * n'occupant que les deux tiers de l'écran. Les placer verticalement forçait
   * l'horloge à rétrécir d'un tiers pendant le réglage. Mesuré.
   *
   * La carte est glissée dans un groupe plutôt que flanquée d'éléments
   * positionnés à la main : l'alignement est celui du navigateur, et rien n'a
   * à être recalculé quand les cartes changent de taille.
   */
  function encadrer(volet, pas, unite) {
    var groupe = document.createElement('div');
    groupe.className = 'groupe';
    var libelle = unite === 'h' ? '1 h' : '5 min';
    groupe.appendChild(creerBoutonPas('−' + libelle, -pas, 'Retirer ' + libelle));
    groupe.appendChild(volet.racine);
    groupe.appendChild(creerBoutonPas('+' + libelle, pas, 'Ajouter ' + libelle));
    el.cartes.appendChild(groupe);
  }

  encadrer(volets[0], PAS_HEURE, 'h');
  encadrer(volets[1], PAS_MINUTE, 'min');

  // ── Écouteurs ───────────────────────────────────────────────────────────
  el.startPause.addEventListener('click', function (e) { e.stopPropagation(); basculer(); });
  el.reset.addEventListener('click', function (e) { e.stopPropagation(); remettreAZero(); });
  el.synchro.addEventListener('click', function (e) {
    e.stopPropagation();
    if (window.SuiviUI) window.SuiviUI.ouvrirSynchro();
  });
  el.mode.addEventListener('click', function (e) { e.stopPropagation(); basculerMode(); });
  el.progression.addEventListener('click', function (e) {
    e.stopPropagation();
    if (window.SuiviUI) window.SuiviUI.ouvrirProgression();
  });

  // Toute la scène commande : viser un bouton de quelques millimètres sur un
  // appareil posé à un mètre n'a aucun intérêt.
  el.scene.addEventListener('click', function () {
    // Un panneau ouvert couvre l'écran : une tape qui le traverserait
    // démarrerait le chronomètre dans le dos de l'utilisateur.
    if (window.SuiviUI && window.SuiviUI.ouvert()) return;
    // Les commandes effacées : cette tape-là ne fait que les rappeler. Sans
    // cela, vouloir simplement revoir les boutons mettrait le chrono en pause.
    if (document.body.classList.contains('epure')) { reveillerBarre(); return; }
    basculer();
  });

  ['pointerdown', 'pointermove', 'keydown'].forEach(function (evenement) {
    document.addEventListener(evenement, reveillerBarre, { passive: true });
  });

  document.addEventListener('keydown', function (e) {
    if (window.SuiviUI && window.SuiviUI.ouvert()) {
      if (e.key === 'Escape') window.SuiviUI.fermer();
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); basculer(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); remettreAZero(); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); basculerPleinEcran(); }
    else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); basculerMode(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ajusterDuree(PAS_MINUTE); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); ajusterDuree(-PAS_MINUTE); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ajusterDuree(PAS_HEURE); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); ajusterDuree(-PAS_HEURE); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    // Le système a repris le verrou d'écran pendant l'absence, et l'affichage
    // peut avoir plusieurs minutes de retard : on rattrape les deux.
    garderEcranAllume();
    majVolets(T.displayMs(state, Date.now()), false);
    majBouton();
  });

  ['pointerdown', 'keydown'].forEach(function (evenement) {
    document.addEventListener(evenement, taire, { passive: true });
  });

  window.addEventListener('beforeunload', ecrire);

  // ── Démarrage ───────────────────────────────────────────────────────────
  construireDurees();
  majMode();
  majVolets(T.displayMs(state, Date.now()), false);   // sans bascule : c'est un état retrouvé
  majBouton();
  reveillerBarre();
  garderEcranAllume();
  // Quatre fois par seconde, alors que l'affichage ne change qu'une fois par
  // minute : c'est la **frontière** de la minute qu'il s'agit de ne pas rater.
  // Scruter à la minute ferait dériver la bascule de plusieurs secondes, et
  // le titre de la page, lui, porte toujours les secondes.
  setInterval(tick, 250);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        logErreur('serviceWorker : enregistrement impossible', err);
      });
    });
  }
})();
