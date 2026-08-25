/*
 * Chrono — câblage de la PWA.
 *
 * Le calcul du temps n'est pas ici : il vient de `timer.js`, le moteur de
 * l'application de bureau, copié tel quel au moment de la construction. Cette
 * page n'en utilise que le mode chrono, mais elle hérite ainsi de ses garanties
 * — horodatage absolu, relecture défensive — et des 68 tests qui les couvrent.
 * Réécrire un compteur ici aurait été plus court et moins sûr.
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

  var state = T.hydrate(lire(), Date.now());
  // Un état relu d'une version antérieure, ou tout simplement le premier
  // démarrage, arrive en mode Focus : cette page n'en connaît qu'un.
  if (!T.isChrono(state.session.mode)) T.selectMode(state, 'chrono');

  // ── Éléments ────────────────────────────────────────────────────────────
  var el = {
    scene:      document.getElementById('scene'),
    cartes:     document.getElementById('flip-cartes'),
    barre:      document.getElementById('barre'),
    startPause: document.getElementById('startpause'),
    icone:      document.getElementById('icone-forme'),
    reset:      document.getElementById('reset'),
    pleinEcran: document.getElementById('plein-ecran')
  };

  var ICONE_LECTURE = 'M7 4l13 8-13 8z';
  var ICONE_PAUSE = 'M7 4h3.5v16H7zM13.5 4H17v16h-3.5z';

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
  volets.forEach(function (v) { el.cartes.appendChild(v.racine); });

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

  function majVolets(ms, anime) {
    var minutes = Math.floor(Math.max(0, ms) / 60000);
    poserVolet(volets[0], pad2(Math.floor(minutes / 60)), anime);
    poserVolet(volets[1], pad2(minutes % 60), anime);
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
    if (!('wakeLock' in navigator) || verrouEcran || !state.session.running) return;
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

  // ── Effacement des commandes ────────────────────────────────────────────
  var DELAI_EFFACEMENT_MS = 4000;
  var minuterieBarre = null;

  function reveillerBarre() {
    el.barre.classList.remove('effacee');
    if (minuterieBarre) clearTimeout(minuterieBarre);
    // Les commandes ne s'effacent que si le chrono tourne : à l'arrêt, elles
    // sont la seule chose à faire sur cette page.
    if (!state.session.running) return;
    minuterieBarre = setTimeout(function () {
      el.barre.classList.add('effacee');
    }, DELAI_EFFACEMENT_MS);
  }

  // ── Affichage ───────────────────────────────────────────────────────────
  function majBouton() {
    var enCours = state.session.running;
    el.icone.setAttribute('d', enCours ? ICONE_PAUSE : ICONE_LECTURE);
    document.title = T.formatElapsed(T.displayMs(state, Date.now())) + ' — Chrono';
  }

  function tick() {
    majVolets(T.displayMs(state, Date.now()), true);
    majBouton();
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  function basculer() {
    T.toggle(state, Date.now());
    ecrire();
    majBouton();
    reveillerBarre();
    if (state.session.running) garderEcranAllume(); else relacherEcran();
  }

  function remettreAZero() {
    T.reset(state);
    ecrire();
    relacherEcran();
    majVolets(0, false);
    majBouton();
    reveillerBarre();
  }

  function basculerPleinEcran() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    } catch (err) {
      logErreur('basculerPleinEcran : refusé par le navigateur', err);
    }
  }

  // ── Écouteurs ───────────────────────────────────────────────────────────
  el.startPause.addEventListener('click', function (e) { e.stopPropagation(); basculer(); });
  el.reset.addEventListener('click', function (e) { e.stopPropagation(); remettreAZero(); });
  el.pleinEcran.addEventListener('click', function (e) { e.stopPropagation(); basculerPleinEcran(); });

  // Toute la scène commande : viser un bouton de quelques millimètres sur un
  // appareil posé à un mètre n'a aucun intérêt.
  el.scene.addEventListener('click', basculer);

  ['pointerdown', 'pointermove', 'keydown'].forEach(function (evenement) {
    document.addEventListener(evenement, reveillerBarre, { passive: true });
  });

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); basculer(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); remettreAZero(); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); basculerPleinEcran(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    // Le système a repris le verrou d'écran pendant l'absence, et l'affichage
    // peut avoir plusieurs minutes de retard : on rattrape les deux.
    garderEcranAllume();
    majVolets(T.displayMs(state, Date.now()), false);
    majBouton();
  });

  window.addEventListener('beforeunload', ecrire);

  // ── Démarrage ───────────────────────────────────────────────────────────
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
