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

  //: Durée voulue du minuteur, en secondes. Gardée hors des réglages du
  //: moteur : `focusMin` y est un entier de minutes, borné à 1 au minimum.
  var CLE_DUREE = 'chrono_pwa_duree_s';

  var DUREE_MIN_MS = 5000;
  //: 99 minutes : au-delà, le compteur des minutes ne tiendrait plus dans les
  //: deux chiffres d'une carte.
  var DUREE_MAX_MS = 99 * 60000;

  var PAS_MINUTE_MS = 60000;
  //: Cinq secondes : de quoi composer 3:30 ou 0:45 sans faire tapoter
  //: trente fois pour une demi-minute.
  var PAS_SECONDE_MS = 5000;

  //: Durées proposées, en minutes. Bornées à 60 : au-delà, l'affichage à deux
  //: volets (MM:SS) ne saurait plus dire la différence entre 90 et 30 minutes.
  var DUREES = [1, 3, 5, 10, 15, 20, 25, 30, 45, 60];

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

  function enMinuteur() { return state.session.mode === MINUTEUR; }

  // ── Durée du minuteur ───────────────────────────────────────────────────

  /**
   * La durée voulue est gardée **ici**, en secondes, et non dans les réglages
   * du moteur : `focusMin` y est un entier de minutes borné à 1 au minimum, ce
   * qui interdirait aussi bien 45 secondes que 3 min 30. Le moteur n'a pas à
   * s'en trouver modifié pour autant — il suffit de reposer `durationMs`, qu'il
   * recalcule de son côté, avec la valeur voulue.
   */
  function dureeVoulueMs() {
    try {
      var brut = parseInt(localStorage.getItem(CLE_DUREE), 10);
      if (isFinite(brut) && brut > 0) {
        return Math.min(DUREE_MAX_MS, Math.max(DUREE_MIN_MS, brut * 1000));
      }
    } catch (err) {
      logErreur('dureeVoulueMs : localStorage illisible', err);
    }
    // Première utilisation : la durée par défaut du moteur, 25 minutes.
    return state.settings.focusMin * 60000;
  }

  function ecrireDuree(ms) {
    try {
      localStorage.setItem(CLE_DUREE, String(Math.round(ms / 1000)));
    } catch (err) {
      logErreur('ecrireDuree : localStorage indisponible', err);
    }
  }

  /**
   * Repose la durée là où le moteur la lit.
   *
   * `durationMs` n'est pas sérialisé : le moteur le recalcule depuis les
   * réglages à chaque relecture. Il est donc reposé ici — et **seulement lui**.
   * Toucher aussi à `remainingMs` écraserait un décompte mis en pause avant un
   * rechargement : c'est la valeur restante qui est stockée, pas la durée.
   */
  function poserDuree() {
    if (!enMinuteur()) return;
    state.session.durationMs = dureeVoulueMs();
  }

  /** Rearme l'intervalle sur la durée voulue, minuteur à l'arrêt. */
  function rearmer() {
    T.reset(state);
    poserDuree();
    state.session.remainingMs = state.session.durationMs;
    taire();
    ecrire();
    majDurees();
    majVolets(T.displayMs(state, Date.now()), false);
    majBouton();
    reveillerBarre();
  }

  /** Change la durée voulue. `deltaMs` peut être négatif. */
  function ajusterDuree(deltaMs) {
    if (!enMinuteur() || state.session.running) return;
    var voulue = dureeVoulueMs() + deltaMs;
    if (voulue < DUREE_MIN_MS) voulue = DUREE_MIN_MS;
    if (voulue > DUREE_MAX_MS) voulue = DUREE_MAX_MS;
    ecrireDuree(voulue);
    rearmer();
  }

  function choisirDuree(minutes) {
    if (!enMinuteur()) return;
    ecrireDuree(minutes * 60000);
    rearmer();
  }

  // ── Éléments ────────────────────────────────────────────────────────────
  var el = {
    scene:      document.getElementById('scene'),
    cartes:     document.getElementById('flip-cartes'),
    barre:      document.getElementById('barre'),
    startPause: document.getElementById('startpause'),
    icone:      document.getElementById('icone-forme'),
    reset:      document.getElementById('reset'),
    pleinEcran: document.getElementById('plein-ecran'),
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

  /**
   * Pose les deux volets. Le découpage dépend du mode, et ce n'est pas un
   * caprice :
   *
   *   chrono   HH:MM — on le laisse tourner une heure ou deux, et une carte
   *                    des secondes qui bascule sans arrêt tire l'œil.
   *   minuteur MM:SS — on le regarde finir. Les dernières secondes sont
   *                    précisément ce qu'on vient y lire.
   *
   * Les arrondis diffèrent aussi, dans le même esprit que `formatElapsed` et
   * `formatMs` du moteur : un temps écoulé se **tronque** (00:00 tant que la
   * première seconde n'est pas passée), un décompte s'arrondit **au
   * supérieur** (25:00 affiché à la seconde zéro, et le 00:01 n'est pas sauté).
   */
  function majVolets(ms, anime) {
    var haut, bas;
    if (enMinuteur()) {
      var sec = Math.max(0, Math.ceil(ms / 1000));
      haut = Math.floor(sec / 60);
      bas = sec % 60;
    } else {
      var minutes = Math.floor(Math.max(0, ms) / 60000);
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
    var maintenant = Date.now();
    // Le titre porte les secondes dans les deux modes : il sert de repli quand
    // la page tourne dans un onglet, où les volets ne se voient pas.
    document.title = enMinuteur()
      ? T.formatMs(T.remainingAt(state, maintenant)) + ' — Minuteur'
      : T.formatElapsed(T.displayMs(state, maintenant)) + ' — Chrono';
  }

  function majMode() {
    var minuteur = enMinuteur();
    // L'icône montre **ce vers quoi on bascule** : un bouton qui affiche
    // l'état courant n'apprend rien à qui le regarde.
    el.iconeMode.setAttribute('d', minuteur ? ICONE_VERS_CHRONO : ICONE_VERS_MINUTEUR);
    el.mode.setAttribute('aria-label',
      minuteur ? 'Passer au chronomètre' : 'Passer au minuteur');
    document.body.classList.toggle('minuteur', minuteur);
    majDurees();
  }

  function construireDurees() {
    DUREES.forEach(function (minutes) {
      var bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'duree';
      bouton.textContent = minutes;
      bouton.setAttribute('aria-label', minutes + ' minutes');
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
    // Même condition, autre usage : elle arme les chevrons des cartes.
    document.body.classList.toggle('reglable', visibles);
    // Une pastille n'est marquée que si la durée voulue lui correspond
    // exactement : après un réglage à 3 min 30, aucune ne doit paraître
    // choisie, sans quoi la rangée mentirait sur l'état.
    var choisie = dureeVoulueMs() / 60000;
    Array.prototype.forEach.call(el.durees.children, function (bouton) {
      var actif = parseInt(bouton.textContent, 10) === choisie;
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
    if (enMinuteur() && state.session.running
        && T.remainingAt(state, maintenant) <= 0) {
      terminer(maintenant);
    }
    majVolets(T.displayMs(state, maintenant), true);
    majBouton();
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  function basculer() {
    taire();
    // Le geste qui démarre est aussi celui qui ouvre le contexte audio : au
    // moment où le minuteur sonnera, plus personne ne touchera l'écran.
    reveillerAudio();
    T.toggle(state, Date.now());
    ecrire();
    majDurees();
    majVolets(T.displayMs(state, Date.now()), false);
    majBouton();
    reveillerBarre();
    if (state.session.running) garderEcranAllume(); else relacherEcran();
  }

  function remettreAZero() {
    if (enMinuteur()) { relacherEcran(); rearmer(); return; }
    taire();
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
    T.selectMode(state, enMinuteur() ? 'chrono' : MINUTEUR);
    // `selectMode` repose la durée du mode d'après les réglages : en minuteur,
    // c'est la durée voulue qui fait foi, pas `focusMin`.
    poserDuree();
    if (enMinuteur()) state.session.remainingMs = state.session.durationMs;
    ecrire();
    relacherEcran();
    majMode();
    majVolets(T.displayMs(state, Date.now()), false);
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

  // ── Régler la durée en touchant les cartes ──────────────────────────────
  //
  // Les deux cartes sont les plus grandes cibles de l'écran : autant s'en
  // servir. Moitié haute pour ajouter, moitié basse pour retirer — la carte de
  // gauche par minute, celle de droite par pas de cinq secondes. Les durées
  // toutes prêtes restent là pour les sauts (25 minutes en une tape) ; ceci
  // sert au réglage fin, et rend accessible n'importe quelle durée.
  //
  // L'appui prolongé répète, en accélérant après la première seconde : sans
  // cela, régler 45 minutes demanderait quarante-cinq tapes.

  var PREMIER_DELAI_MS = 420;
  var REPETITION_MS = 110;
  var repetition = null;

  function arreterRepetition() {
    if (repetition === null) return;
    clearTimeout(repetition);
    clearInterval(repetition);
    repetition = null;
  }

  function demarrerRepetition(deltaMs) {
    arreterRepetition();
    ajusterDuree(deltaMs);
    repetition = setTimeout(function () {
      repetition = setInterval(function () { ajusterDuree(deltaMs); },
                               REPETITION_MS);
    }, PREMIER_DELAI_MS);
  }

  function armerCarte(carte, pasMs) {
    carte.addEventListener('pointerdown', function (e) {
      if (!enMinuteur() || state.session.running) return;   // la tape démarre
      // La carte cesse d'être une simple surface de commande : sans cela, le
      // réglage démarrerait le minuteur du même geste.
      e.preventDefault();
      e.stopPropagation();
      var boite = carte.getBoundingClientRect();
      var versLeHaut = (e.clientY - boite.top) < boite.height / 2;
      carte.classList.add(versLeHaut ? 'regle-plus' : 'regle-moins');
      demarrerRepetition(versLeHaut ? pasMs : -pasMs);
      try { carte.setPointerCapture(e.pointerId); } catch (err) { /* sans gravité */ }
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (evenement) {
      carte.addEventListener(evenement, function () {
        arreterRepetition();
        carte.classList.remove('regle-plus', 'regle-moins');
      });
    });

    // Un clic qui suit un pointerdown déjà traité ne doit pas remonter jusqu'à
    // la scène, sinon chaque réglage démarrerait le décompte.
    carte.addEventListener('click', function (e) {
      if (!enMinuteur() || state.session.running) return;
      e.stopPropagation();
    });
  }

  armerCarte(volets[0].racine, PAS_MINUTE_MS);
  armerCarte(volets[1].racine, PAS_SECONDE_MS);

  // ── Écouteurs ───────────────────────────────────────────────────────────
  el.startPause.addEventListener('click', function (e) { e.stopPropagation(); basculer(); });
  el.reset.addEventListener('click', function (e) { e.stopPropagation(); remettreAZero(); });
  el.pleinEcran.addEventListener('click', function (e) { e.stopPropagation(); basculerPleinEcran(); });
  el.mode.addEventListener('click', function (e) { e.stopPropagation(); basculerMode(); });

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
    else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); basculerMode(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); ajusterDuree(PAS_MINUTE_MS); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); ajusterDuree(-PAS_MINUTE_MS); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ajusterDuree(PAS_SECONDE_MS); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); ajusterDuree(-PAS_SECONDE_MS); }
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
  poserDuree();   // `durationMs` n'est pas sérialisé : le moteur l'a recalculé
                  // depuis `focusMin`, il faut y remettre la durée voulue.
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
