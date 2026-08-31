/*
 * Suivi du temps — panneaux, catégories et synchronisation.
 *
 * Le calcul n'est pas ici : il vient de `suivi.js`, moteur pur éprouvé sans
 * navigateur. Ce fichier ne fait que trois choses — poser les questions,
 * afficher les résultats, et tenir le journal à jour des deux côtés.
 *
 * RIEN DE SECRET N'ENTRE DANS CE FICHIER. L'adresse du projet, la clé et le
 * secret de synchro arrivent par un « code » que l'utilisateur colle une fois
 * par appareil, exactement comme pour l'application TaskMint. Le dépôt qui sert
 * cette page est public : une clé écrite ici serait publiée avec elle.
 */
(function () {
  'use strict';

  var S = window.SuiviTravail;

  var CLE_JOURNAL = 'chrono_pwa_journal';
  var CLE_CATEGORIES = 'chrono_pwa_categories';
  var CLE_SYNC = 'chrono_pwa_sync';

  //: Les sessions terminées dont la catégorie n'a pas encore été donnée.
  //: PERSISTÉES, ET C'EST TOUT L'INTÉRÊT : quand la question est posée, le
  //: chronomètre a déjà été remis à zéro et le minuteur déjà arrêté. Le temps
  //: écoulé ne vit plus que là. Le garder en mémoire seule l'effaçait dès que
  //: le système déchargeait la page — changer d'onglet suffisait.
  //:
  //: Une file plutôt qu'une seule session : deux minuteurs peuvent se terminer
  //: sans qu'on ait répondu au premier, et le perdre serait exactement le
  //: défaut qu'on corrige ici.
  var CLE_ATTENTE = 'chrono_pwa_attente';

  var TABLE_SESSIONS = 'chrono_sessions';
  var TABLE_CATEGORIES = 'chrono_categories';

  //: Cycle de synchronisation. Le journal est en ajout seul et bouge rarement :
  //: le rythme des tâches (8 s) n'aurait ici aucun sens.
  var SYNC_MS = 60000;

  //: En deçà, on ne demande rien. Une remise à zéro par mégarde, un minuteur
  //: relancé aussitôt : poser la question à chaque fois rendrait le bouton
  //: pénible et le journal faux.
  var DUREE_MINIMALE_MS = 60000;

  //: Premières catégories d'un appareil neuf. Elles se renomment et se
  //: suppriment : c'est une amorce, pas une liste imposée.
  var CATEGORIES_INITIALES = ['SQL', 'Pandas', 'Python'];

  function logErreur(contexte, err) {
    console.error('[Suivi] ' + contexte, err);
  }

  // ── Stockage local ──────────────────────────────────────────────────────

  function lire(cle, defaut) {
    try {
      var brut = localStorage.getItem(cle);
      return brut ? JSON.parse(brut) : defaut;
    } catch (err) {
      logErreur('lire ' + cle, err);
      return defaut;
    }
  }

  function ecrire(cle, valeur) {
    try {
      localStorage.setItem(cle, JSON.stringify(valeur));
    } catch (err) {
      logErreur('ecrire ' + cle, err);
    }
  }

  var journal = lire(CLE_JOURNAL, []) || [];
  var categories = lire(CLE_CATEGORIES, null);
  var cfg = lire(CLE_SYNC, null);

  if (!Array.isArray(categories)) categories = [];

  /**
   * Pose les premières catégories d'un appareil qui n'en a aucune.
   *
   * APPELÉE APRÈS LA PREMIÈRE SYNCHRO, JAMAIS AVANT. Amorcer au chargement
   * paraissait naturel et produisait des doublons : deux appareils couplés
   * créaient chacun leurs trois catégories, avec des identifiants distincts —
   * et la fusion, qui n'a aucune raison de rapprocher deux lignes différentes,
   * en rendait six. Un appareil couplé attend donc de savoir ce que les autres
   * ont déjà avant de proposer quoi que ce soit.
   */
  function amorcer() {
    if (categoriesVives().length) return;
    var maintenant = Date.now();
    CATEGORIES_INITIALES.forEach(function (nom) {
      categories.push({ id: identifiant(), nom: nom, supprime: false,
                        majA: maintenant, sale: true });
    });
    ecrire(CLE_CATEGORIES, categories);
  }

  /**
   * Un identifiant unique.
   *
   * `crypto.randomUUID` n'existe pas partout — notamment sur les vieux appareils
   * auxquels cette page est destinée, et hors contexte sécurisé. Le repli n'a
   * pas à être cryptographique : il doit seulement éviter qu'un même identifiant
   * naisse deux fois sur deux appareils, d'où l'horodatage en préfixe.
   */
  function identifiant() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (err) { /* on passe au repli */ }
    return Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 10) +
           Math.random().toString(36).slice(2, 6);
  }

  function categoriesVives() {
    return categories.filter(function (c) { return !c.supprime; });
  }

  function nomDe(id) {
    var trouvee = categories.filter(function (c) { return c.id === id; })[0];
    return trouvee ? trouvee.nom : id;
  }

  // ── Éléments ────────────────────────────────────────────────────────────
  var el = {
    voileFin: document.getElementById('voile-fin'),
    finDuree: document.getElementById('fin-duree'),
    finChoix: document.getElementById('fin-choix'),
    finIgnorer: document.getElementById('fin-ignorer'),
    voileProg: document.getElementById('voile-progression'),
    progTitre: document.getElementById('prog-titre'),
    progCorps: document.getElementById('prog-corps'),
    progFermer: document.getElementById('prog-fermer'),
    progCategories: document.getElementById('prog-categories'),
    progSynchro: document.getElementById('prog-synchro')
  };

  /** La file des sessions à classer, relue du stockage au démarrage. */
  function fileAttente() {
    var brut = lire(CLE_ATTENTE, []);
    if (!Array.isArray(brut)) return [];
    return brut.filter(function (s) {
      return s && isFinite(s.debut) && isFinite(s.dureeMs) &&
             s.dureeMs >= DUREE_MINIMALE_MS;
    });
  }

  var attente = fileAttente();
  var vueProgression = 'progression';   // 'progression' | 'categories' | 'synchro'

  function ouvert() {
    return !el.voileFin.hidden || !el.voileProg.hidden;
  }

  // ── Fin de session ──────────────────────────────────────────────────────

  /**
   * Propose de compter le temps qui vient de s'écouler.
   *
   * Appelée à la fin d'un minuteur et à la remise à zéro du chronomètre. Le
   * temps est déjà passé : la question ne peut donc rien perturber, et c'est
   * pour cela qu'elle se pose là plutôt qu'au démarrage.
   */
  function proposer(debut, dureeMs) {
    if (!isFinite(dureeMs) || dureeMs < DUREE_MINIMALE_MS) return false;
    // Une session qu'on ne saurait pas classer serait une session perdue : si
    // la synchro n'a rien rapporté, on amorce plutôt que de ne rien proposer.
    if (!categoriesVives().length) amorcer();
    if (!categoriesVives().length) return false;
    // Écrit AVANT d'afficher : si la page disparaît entre les deux, la session
    // est déjà à l'abri.
    attente.push({ debut: debut, dureeMs: dureeMs });
    ecrire(CLE_ATTENTE, attente);
    montrerAttente();
    return true;
  }

  /** Pose la question pour la première session de la file, s'il y en a une. */
  function montrerAttente() {
    if (!attente.length) { el.voileFin.hidden = true; return false; }
    if (!categoriesVives().length) amorcer();
    if (!categoriesVives().length) return false;
    el.finDuree.textContent = S.formatDuree(attente[0].dureeMs);
    dessinerChoix();
    el.voileFin.hidden = false;
    return true;
  }

  /** Retire la session en tête, qu'elle ait été comptée ou écartée. */
  function defilerAttente() {
    attente.shift();
    ecrire(CLE_ATTENTE, attente);
  }

  function dessinerChoix() {
    var agr = S.agregats(journalAvecNoms(), Date.now());
    var parNom = {};
    agr.categories.forEach(function (c) { parNom[c.categorie] = c; });

    el.finChoix.innerHTML = '';
    categoriesVives().forEach(function (categorie) {
      var bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'categorie';
      bouton.appendChild(document.createTextNode(categorie.nom));
      var connue = parNom[categorie.nom];
      var rang = document.createElement('span');
      rang.className = 'rang';
      rang.textContent = 'niv. ' + (connue ? connue.niveau.niveau : 1);
      bouton.appendChild(rang);
      bouton.addEventListener('click', function () { compter(categorie); });
      el.finChoix.appendChild(bouton);
    });
  }

  /*
   * Le journal garde l'identifiant de la catégorie, pas son nom : renommer
   * « SQL » en « Bases de données » ne doit pas couper l'historique en deux.
   * Le moteur, lui, agrège par libellé — on lui passe donc une vue résolue.
   */
  function journalAvecNoms() {
    return journal.map(function (e) {
      var copie = {};
      Object.keys(e).forEach(function (cle) { copie[cle] = e[cle]; });
      copie.categorie = nomDe(e.categorie);
      return copie;
    });
  }

  function compter(categorie) {
    if (!attente.length) return;
    var session = attente[0];
    var entree = S.creer(identifiant(), session.debut, session.dureeMs, categorie.id);
    if (entree) {
      entree.sale = true;
      journal.push(entree);
      ecrire(CLE_JOURNAL, journal);
      synchroniser();
    }
    defilerAttente();
    // Une autre session peut attendre derrière : on enchaîne plutôt que de
    // renvoyer l'utilisateur vers un écran qui ne dit rien de ce qui reste.
    if (montrerAttente()) return;
    ouvrirProgression();
  }

  /** Ferme la question sans rien décider. La session reste dans la file. */
  function fermerFin() {
    el.voileFin.hidden = true;
  }

  // « Ne pas compter » est le seul geste qui jette une session : la fermeture
  // ne fait que remettre la question à plus tard.
  el.finIgnorer.addEventListener('click', function () {
    defilerAttente();
    if (!montrerAttente()) el.voileFin.hidden = true;
  });

  // ── Progression ─────────────────────────────────────────────────────────

  function ouvrirProgression() {
    vueProgression = 'progression';
    dessinerProgression();
    el.voileProg.hidden = false;
  }

  function fermerProgression() { el.voileProg.hidden = true; }

  el.progFermer.addEventListener('click', fermerProgression);
  el.progCategories.addEventListener('click', function () {
    vueProgression = vueProgression === 'categories' ? 'progression' : 'categories';
    dessinerProgression();
  });
  el.progSynchro.addEventListener('click', function () {
    vueProgression = vueProgression === 'synchro' ? 'progression' : 'synchro';
    dessinerProgression();
  });

  function vider(noeud) { while (noeud.firstChild) noeud.removeChild(noeud.firstChild); }

  function elem(balise, classe, texte) {
    var n = document.createElement(balise);
    if (classe) n.className = classe;
    if (texte !== undefined && texte !== null) n.textContent = texte;
    return n;
  }

  function dessinerProgression() {
    vider(el.progCorps);
    if (vueProgression === 'categories') { el.progTitre.textContent = 'Catégories'; dessinerCategories(); return; }
    if (vueProgression === 'synchro') { el.progTitre.textContent = 'Synchronisation'; dessinerSynchro(); return; }
    el.progTitre.textContent = 'Progression';

    var agr = S.agregats(journalAvecNoms(), Date.now());

    if (!agr.sessions) {
      el.progCorps.appendChild(elem('p', 'vide',
        'Rien de compté pour l\'instant. À la fin d\'un minuteur, ou quand tu ' +
        'remets le chronomètre à zéro, on te demandera sur quoi tu as travaillé.'));
      return;
    }

    var totaux = elem('div', 'totaux');
    [['Aujourd\'hui', S.formatDuree(agr.jour)],
     ['Cette semaine', S.formatDuree(agr.semaine)],
     ['Série', agr.serie + (agr.serie > 1 ? ' jours' : ' jour')]
    ].forEach(function (paire) {
      var carte = elem('div', 'total');
      carte.appendChild(elem('div', 'total-valeur', paire[1]));
      carte.appendChild(elem('div', 'total-nom', paire[0]));
      totaux.appendChild(carte);
    });
    el.progCorps.appendChild(totaux);

    // Niveau général : le blason en grand, c'est la récompense qu'on vient
    // regarder. Le reste l'accompagne, il ne le remplace pas.
    var general = elem('div', 'general');
    general.appendChild(blason(agr.global.niveau, 'grand'));
    var cote = elem('div', 'general-cote');
    cote.appendChild(elem('div', 'general-rang', 'Niveau ' + agr.global.niveau));
    cote.appendChild(elem('div', 'general-nom',
                          S.formatDuree(agr.total) + ' au total'));
    cote.appendChild(jauge(agr.global.fraction));
    cote.appendChild(elem('div', 'general-reste',
      S.formatDuree(agr.global.minutesPourSuivant * S.MS_MINUTE) +
      ' avant le niveau ' + (agr.global.niveau + 1)));
    general.appendChild(cote);
    el.progCorps.appendChild(general);

    // Sept derniers jours.
    var maxi = agr.jours.reduce(function (m, j) { return Math.max(m, j.ms); }, 0);
    var semaine = elem('div', 'semaine');
    var LETTRES = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
    agr.jours.forEach(function (j) {
      var colonne = elem('div', 'barre-jour' + (j.ms > 0 ? ' travaille' : ''));
      var barre = elem('i');
      // Une part de la plus longue journée : l'échelle absolue rendrait toutes
      // les colonnes minuscules dès qu'une journée sort du lot.
      barre.style.height = (maxi > 0 ? Math.max(3, Math.round(100 * j.ms / maxi)) : 3) + '%';
      colonne.appendChild(barre);
      var d = new Date(j.jour + 'T12:00:00');
      colonne.appendChild(elem('u', null, LETTRES[(d.getDay() + 6) % 7]));
      semaine.appendChild(colonne);
    });
    el.progCorps.appendChild(semaine);

    // Par catégorie.
    var lignes = elem('div', 'lignes');
    agr.categories.forEach(function (c) {
      var ligne = elem('div', 'ligne ligne-blason');
      ligne.appendChild(blason(c.niveau.niveau));
      var corps = elem('div', 'ligne-corps');
      var tete = elem('div', 'ligne-tete');
      tete.appendChild(elem('span', 'ligne-nom', c.categorie));
      tete.appendChild(elem('span', 'ligne-temps', S.formatDuree(c.ms)));
      corps.appendChild(tete);
      corps.appendChild(jauge(c.niveau.fraction));
      corps.appendChild(elem('div', 'ligne-pied',
        'Niveau ' + c.niveau.niveau + ' · ' +
        S.formatDuree(c.niveau.minutesPourSuivant * S.MS_MINUTE) +
        ' avant le ' + (c.niveau.niveau + 1)));
      ligne.appendChild(corps);
      lignes.appendChild(ligne);
    });
    el.progCorps.appendChild(lignes);
  }

  //: Il existe dix blasons ; au-delà, le dernier sert de plafond. Le nombre
  //: écrit au centre reste le vrai niveau : c'est le blason qui plafonne, pas
  //: la progression.
  var BLASONS = 10;

  /**
   * Le blason d'un niveau.
   *
   * Il ne porte aucun chiffre : le dessin parle de lui-même, et le niveau est
   * écrit à côté. Le nombre a d'abord été posé au centre, ce qui obligeait à
   * effacer l'emblème du disque — on rendait le blason moins beau pour y loger
   * une information qui tenait très bien ailleurs.
   */
  function blason(niveau, taille) {
    var boite = elem('div', 'blason' + (taille ? ' blason-' + taille : ''));
    var image = document.createElement('img');
    var rang = Math.max(1, Math.min(BLASONS, niveau));
    image.src = 'badges/badge-' + (rang < 10 ? '0' : '') + rang + '.png';
    image.alt = 'Niveau ' + niveau;
    boite.appendChild(image);
    return boite;
  }

  function jauge(fraction) {
    var j = elem('div', 'jauge');
    var dedans = elem('span');
    dedans.style.width = Math.round(100 * Math.max(0, Math.min(1, fraction))) + '%';
    j.appendChild(dedans);
    return j;
  }

  // ── Catégories ──────────────────────────────────────────────────────────

  function dessinerCategories() {
    var saisie = elem('div', 'saisie');
    var champ = document.createElement('input');
    champ.type = 'text';
    champ.placeholder = 'Nouvelle catégorie';
    champ.maxLength = 40;
    var ajout = elem('button', 'bouton', 'Ajouter');
    saisie.appendChild(champ);
    saisie.appendChild(ajout);
    el.progCorps.appendChild(saisie);

    function ajouter() {
      var nom = champ.value.trim();
      if (!nom) return;
      var existe = categoriesVives().some(function (c) {
        return c.nom.toLowerCase() === nom.toLowerCase();
      });
      if (existe) { champ.value = ''; return; }
      categories.push({ id: identifiant(), nom: nom, supprime: false,
                        majA: Date.now(), sale: true });
      ecrire(CLE_CATEGORIES, categories);
      synchroniser();
      champ.value = '';
      dessinerProgression();
    }
    ajout.addEventListener('click', ajouter);
    champ.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ajouter(); }
    });

    var lignes = elem('div', 'lignes');
    var agr = S.agregats(journalAvecNoms(), Date.now());
    var parNom = {};
    agr.categories.forEach(function (c) { parNom[c.categorie] = c; });

    categoriesVives().forEach(function (categorie) {
      var ligne = elem('div', 'ligne');
      var tete = elem('div', 'ligne-tete');

      // Le nom est modifiable sur place : renommer ne coupe pas l'historique,
      // puisque le journal retient l'identifiant et non le libellé.
      var champNom = document.createElement('input');
      champNom.type = 'text';
      champNom.value = categorie.nom;
      champNom.maxLength = 40;
      champNom.className = 'ligne-nom';
      champNom.style.background = 'none';
      champNom.style.border = 'none';
      champNom.style.color = 'inherit';
      champNom.style.font = 'inherit';
      champNom.style.flex = '1 1 auto';
      champNom.style.minWidth = '0';
      champNom.addEventListener('change', function () {
        var nom = champNom.value.trim();
        if (!nom) { champNom.value = categorie.nom; return; }
        categorie.nom = nom;
        categorie.majA = Date.now();
        categorie.sale = true;
        ecrire(CLE_CATEGORIES, categories);
        synchroniser();
      });
      tete.appendChild(champNom);

      var compte = parNom[categorie.nom];
      tete.appendChild(elem('span', 'ligne-temps',
                            compte ? S.formatDuree(compte.ms) : '—'));

      var retirer = elem('button', 'retirer', '×');
      retirer.setAttribute('aria-label', 'Retirer ' + categorie.nom);
      retirer.addEventListener('click', function () {
        categorie.supprime = true;
        categorie.majA = Date.now();
        categorie.sale = true;
        ecrire(CLE_CATEGORIES, categories);
        synchroniser();
        dessinerProgression();
      });
      tete.appendChild(retirer);

      ligne.appendChild(tete);
      lignes.appendChild(ligne);
    });
    el.progCorps.appendChild(lignes);

    el.progCorps.appendChild(elem('p', 'note',
      'Retirer une catégorie ne supprime pas le temps déjà compté : il reste ' +
      'dans l’historique. Renommer non plus — le journal retient la catégorie, ' +
      'pas son nom.'));
  }

  // ── Synchronisation ─────────────────────────────────────────────────────

  var etatSync = cfg ? 'attente' : 'absente';
  var enCours = false;

  function dessinerSynchro() {
    var etat = elem('div', 'etat-synchro' +
      (etatSync === 'ok' ? ' ok' : (etatSync === 'panne' ? ' panne' : '')));
    etat.appendChild(elem('i'));
    etat.appendChild(elem('span', null, {
      absente: 'Aucun appareil couplé — ce suivi ne vit que sur ce téléphone.',
      attente: 'Couplé, synchronisation en attente.',
      ok: 'Couplé et à jour.',
      panne: 'Couplé, mais la dernière synchronisation a échoué.'
    }[etatSync] || etatSync));
    el.progCorps.appendChild(etat);

    var saisie = elem('div', 'saisie');
    var champ = document.createElement('input');
    champ.type = 'text';
    champ.placeholder = 'Coller le code de synchro';
    var valider = elem('button', 'bouton', 'Activer');
    saisie.appendChild(champ);
    saisie.appendChild(valider);
    el.progCorps.appendChild(saisie);

    valider.addEventListener('click', function () {
      try {
        var lu = JSON.parse(atob(champ.value.trim()));
        if (!lu.u || !lu.k || !lu.s) throw new Error('code incomplet');
        lu.u = String(lu.u).replace(/\/+$/, '');
        cfg = { u: lu.u, k: lu.k, s: lu.s };
        ecrire(CLE_SYNC, cfg);
        etatSync = 'attente';
        champ.value = '';
        synchroniser();
        dessinerProgression();
      } catch (err) {
        logErreur('code de synchro illisible', err);
        etatSync = 'panne';
        dessinerProgression();
      }
    });

    if (cfg) {
      var couper = elem('button', 'bouton bouton-discret', 'Découpler cet appareil');
      couper.addEventListener('click', function () {
        cfg = null;
        try { localStorage.removeItem(CLE_SYNC); }
        catch (err) { logErreur('découplage', err); }
        etatSync = 'absente';
        dessinerProgression();
      });
      el.progCorps.appendChild(couper);
    }

    el.progCorps.appendChild(elem('p', 'note',
      'Le code est le même que celui de TaskMint : il porte l’adresse du projet, ' +
      'la clé publique et le secret de synchro. Il n’est écrit nulle part dans ' +
      'cette page — le site étant public, une clé qui y figurerait serait publiée ' +
      'avec lui.'));

    // ── Ce que l'appareil dit de son écran ────────────────────────────
    //
    // Un affichage décentré peut venir de deux causes qu'on ne distingue pas
    // à l'œil : soit la vue s'étend sous l'encoche et les marges sûres sont
    // inégales, soit le système l'exclut et la vue elle-même est décalée sur
    // l'écran. Ces quatre nombres tranchent, et rien ne permet de les obtenir
    // depuis un poste de développement.
    var sondeur = document.createElement('div');
    sondeur.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top) env(safe-area-inset-right)' +
      ' env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(sondeur);
    var mesure = getComputedStyle(sondeur);
    var marges = [mesure.paddingTop, mesure.paddingRight,
                  mesure.paddingBottom, mesure.paddingLeft]
      .map(function (v) { return Math.round(parseFloat(v) || 0); });
    document.body.removeChild(sondeur);

    el.progCorps.appendChild(elem('p', 'note',
      'Affichage : ' + window.innerWidth + ' × ' + window.innerHeight +
      ' points, densité ' + (window.devicePixelRatio || 1) +
      ' · zones sûres haut/droite/bas/gauche : ' + marges.join(' / ') + ' px' +
      ' · écran ' + (window.screen ? window.screen.width + ' × ' +
                     window.screen.height : '?') + '.'));

    // ── Centrage de l'horloge ─────────────────────────────────────────
    //
    // Deux boutons plutôt qu'une valeur devinée. Un affichage décentré vient
    // soit d'une vue étendue sous l'encoche avec des marges inégales, soit
    // d'une vue que le système décale — et les deux appellent des corrections
    // de sens opposé. Ce qui se règle à l’œil en trois tapes n’a pas à être
    // deviné depuis un poste qui n’a ni encoche ni téléphone.
    var PAS_DECALAGE = 4;

    function lireDecalage() {
      var v = parseInt(localStorage.getItem('chrono_pwa_decalage'), 10);
      return isFinite(v) ? v : 0;
    }

    var reglage = elem('div', 'centrage');
    var valeur = elem('span', 'centrage-valeur');

    function poserDecalage(px) {
      var borne = Math.max(-120, Math.min(120, px));
      try { localStorage.setItem('chrono_pwa_decalage', String(borne)); }
      catch (err) { logErreur('écrire le décalage', err); }
      if (window.ChronoAffichage) window.ChronoAffichage.appliquerDecalage();
      valeur.textContent = (borne > 0 ? '+' : '') + borne + ' px';
    }

    var versGauche = elem('button', 'bouton bouton-discret', '←');
    versGauche.setAttribute('aria-label', 'Décaler l’horloge vers la gauche');
    versGauche.addEventListener('click', function () {
      poserDecalage(lireDecalage() - PAS_DECALAGE);
    });

    var versDroite = elem('button', 'bouton bouton-discret', '→');
    versDroite.setAttribute('aria-label', 'Décaler l’horloge vers la droite');
    versDroite.addEventListener('click', function () {
      poserDecalage(lireDecalage() + PAS_DECALAGE);
    });

    var centrer = elem('button', 'bouton bouton-discret', 'Centrer');
    centrer.addEventListener('click', function () { poserDecalage(0); });

    reglage.appendChild(elem('span', 'centrage-nom', 'Centrage de l’horloge'));
    reglage.appendChild(versGauche);
    reglage.appendChild(valeur);
    reglage.appendChild(versDroite);
    reglage.appendChild(centrer);
    el.progCorps.appendChild(reglage);
    valeur.textContent = (lireDecalage() > 0 ? '+' : '') + lireDecalage() + ' px';

    el.progCorps.appendChild(elem('p', 'note',
      '← rapproche l’horloge du bord gauche, → l’en éloigne — donc → laisse ' +
      'plus de vide à gauche. Le réglage est propre à cet appareil : il corrige ' +
      'ce que son écran fait, pas ce que l’application calcule.'));  }

  function entetes() {
    return {
      'apikey': cfg.k,
      'Authorization': 'Bearer ' + cfg.k,
      'x-sync-secret': cfg.s,
      'Content-Type': 'application/json'
    };
  }

  function versDistant(table, lignes) {
    if (table === TABLE_SESSIONS) {
      return lignes.map(function (e) {
        return { id: e.id, debut: e.debut, duree_ms: e.dureeMs,
                 categorie: e.categorie, supprime: !!e.supprime, maj_a: e.majA };
      });
    }
    return lignes.map(function (c) {
      return { id: c.id, nom: c.nom, supprime: !!c.supprime, maj_a: c.majA };
    });
  }

  function depuisDistant(table, lignes) {
    if (table === TABLE_SESSIONS) {
      return lignes.map(function (r) {
        return { id: r.id, debut: Number(r.debut), dureeMs: Number(r.duree_ms),
                 categorie: r.categorie, supprime: !!r.supprime,
                 majA: Number(r.maj_a), sale: false };
      });
    }
    return lignes.map(function (r) {
      return { id: r.id, nom: r.nom, supprime: !!r.supprime,
               majA: Number(r.maj_a), sale: false };
    });
  }

  /**
   * Fusion « la plus récente gagne », sur `majA`.
   *
   * Le journal est en **ajout seul** : deux appareils ne modifient jamais la
   * même session, ils en créent chacun de nouvelles. Le seul conflit possible
   * porte sur les catégories — un renommage de part et d'autre — et là,
   * l'horodatage tranche sans qu'on ait à inventer une règle.
   */
  function fusionner(locales, distantes) {
    var par = {};
    locales.forEach(function (l) { par[l.id] = l; });
    distantes.forEach(function (d) {
      var l = par[d.id];
      if (!l) { par[d.id] = d; return; }
      // Une ligne modifiée localement et pas encore poussée gagne : sa version
      // distante est forcément antérieure.
      if (l.sale) return;
      if (d.majA >= l.majA) par[d.id] = d;
    });
    return Object.keys(par).map(function (cle) { return par[cle]; });
  }

  async function echanger(table, locales) {
    var sales = locales.filter(function (l) { return l.sale; });
    if (sales.length) {
      var envoi = await fetch(cfg.u + '/rest/v1/' + table, {
        method: 'POST',
        headers: Object.assign({}, entetes(),
                               { 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(versDistant(table, sales))
      });
      if (!envoi.ok) throw new Error('envoi ' + table + ' : ' + envoi.status);
      sales.forEach(function (l) { l.sale = false; });
    }
    var lecture = await fetch(cfg.u + '/rest/v1/' + table + '?select=*',
                              { headers: entetes() });
    if (!lecture.ok) throw new Error('lecture ' + table + ' : ' + lecture.status);
    return fusionner(locales, depuisDistant(table, await lecture.json()));
  }

  async function synchroniser() {
    if (!cfg || enCours) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    enCours = true;
    try {
      categories = await echanger(TABLE_CATEGORIES, categories);
      journal = await echanger(TABLE_SESSIONS, journal);
      ecrire(CLE_CATEGORIES, categories);
      ecrire(CLE_JOURNAL, journal);
      etatSync = 'ok';
      // Maintenant seulement : on sait ce que les autres appareils ont déjà.
      if (!categoriesVives().length) { amorcer(); ecrire(CLE_CATEGORIES, categories); }
      if (!el.voileProg.hidden) dessinerProgression();
    } catch (err) {
      // Une panne de synchro n'empêche jamais de compter son temps : le journal
      // local reste la source, et le prochain cycle rattrapera.
      logErreur('synchroniser', err);
      etatSync = 'panne';
    } finally {
      enCours = false;
    }
  }

  // Sans couplage, rien ne viendra d'ailleurs : on amorce tout de suite.
  if (!cfg) amorcer();

  if (cfg) {
    synchroniser();
    setInterval(synchroniser, SYNC_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') synchroniser();
    });
  }

  // Une session laissée en attente reprend la parole au chargement suivant :
  // c'est la seule façon qu'elle ne se perde pas quand le système décharge la
  // page avant qu'on ait répondu.
  if (attente.length) montrerAttente();

  // ── Interface publique ──────────────────────────────────────────────────
  function ouvrirSynchro() {
    vueProgression = 'synchro';
    dessinerProgression();
    el.voileProg.hidden = false;
  }

  window.SuiviUI = {
    proposer: proposer,
    ouvrirProgression: ouvrirProgression,
    ouvrirSynchro: ouvrirSynchro,
    fermer: function () { fermerFin(); fermerProgression(); },
    ouvert: ouvert,
    // Exposés pour les tests, qui doivent pouvoir observer sans passer par le
    // stockage : lire `localStorage` ne dirait rien de ce qui est affiché.
    _journal: function () { return journal; },
    _attente: function () { return attente; },
    _categories: function () { return categories; }
  };
})();
