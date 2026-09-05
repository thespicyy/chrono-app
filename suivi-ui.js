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

  //: Combien de temps une suppression reste à confirmer. Assez pour répondre
  //: sans se presser, assez court pour qu'une croix pressée par erreur soit
  //: redevenue une croix quand on y revient.
  var DELAI_CONFIRMATION_MS = 5000;

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
    CATEGORIES_INITIALES.forEach(function (nom) { creerCategorie(nom, 'temps'); });
  }

  /**
   * Crée une catégorie, ou rend celle qui porte déjà ce nom.
   *
   * Retrouver plutôt que créer n'est pas un détail : deux catégories de même
   * nom couperaient l'historique en deux sans que rien ne le signale — et rien
   * ne le signalerait, puisque les deux s'afficheraient.
   */
  function creerCategorie(nom, unite, cout) {
    var propre = String(nom || '').trim();
    if (!propre) return null;
    var connue = categoriesVives().filter(function (c) {
      return c.nom.toLowerCase() === propre.toLowerCase();
    })[0];
    if (connue) return connue;
    var chiffre = parseFloat(cout);
    var neuve = {
      id: identifiant(), nom: propre,
      unite: S.UNITES[unite] ? unite : S.UNITE_DEFAUT,
      // Le coût reste au défaut de l'unité tant que personne ne l'a réglé :
      // `null` dit « celui de l'unité », et suit donc un changement d'unité.
      cout: (isFinite(chiffre) && chiffre > 0) ? chiffre : null,
      supprime: false, majA: Date.now(), sale: true
    };
    categories.push(neuve);
    ecrire(CLE_CATEGORIES, categories);
    return neuve;
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

  function categorieDe(id) {
    return categories.filter(function (c) { return c.id === id; })[0] || null;
  }

  /** L'unité d'une catégorie, par son identifiant. Le temps, à défaut. */
  function uniteDe(id) {
    var c = categorieDe(id);
    return (c && S.UNITES[c.unite]) ? c.unite : S.UNITE_DEFAUT;
  }

  /**
   * L'unité et le coût de chaque catégorie, **par identifiant** — la même clé
   * que celle sous laquelle le moteur agrège.
   */
  function reglages() {
    var carte = {};
    categories.forEach(function (c) {
      carte[c.id] = { unite: c.unite, cout: c.cout };
    });
    return carte;
  }

  /**
   * Les agrégats du moment.
   *
   * Passer par une fonction plutôt que d'appeler `S.agregats` à cinq endroits :
   * les réglages sont un troisième argument facile à oublier, et l'oublier ne
   * lève rien — tout redeviendrait simplement du temps, en silence.
   */
  function bilan() {
    return S.agregats(journalVivant(), Date.now(), reglages());
  }

  // ── Éléments ────────────────────────────────────────────────────────────
  var el = {
    voileFin: document.getElementById('voile-fin'),
    finDuree: document.getElementById('fin-duree'),
    finChoix: document.getElementById('fin-choix'),
    finIgnorer: document.getElementById('fin-ignorer'),
    finSaisie: document.getElementById('fin-saisie'),
    finNouvelle: document.getElementById('fin-nouvelle'),
    finCreer: document.getElementById('fin-creer'),
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

  //: Ce qui veut être prévenu d'un changement du journal ou des catégories —
  //: la face portrait, aujourd'hui. Déclaré ici, et non près de son usage : la
  //: première synchronisation peut aboutir avant la fin du fichier.
  var abonnes = [];

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
    el.finSaisie.hidden = true;
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
    var agr = bilan();
    var parId = {};
    agr.categories.forEach(function (c) { parId[c.categorie] = c; });

    el.finChoix.innerHTML = '';
    categoriesVives().forEach(function (categorie) {
      var bouton = document.createElement('button');
      bouton.type = 'button';
      bouton.className = 'categorie';
      bouton.appendChild(document.createTextNode(categorie.nom));
      var connue = parId[categorie.id];
      var rang = document.createElement('span');
      rang.className = 'rang';
      rang.textContent = 'niv. ' + (connue ? connue.niveau.niveau : 1);
      bouton.appendChild(rang);
      bouton.addEventListener('click', function () { compter(categorie); });
      el.finChoix.appendChild(bouton);
    });

    // En dernier, distincte des autres : créer une catégorie ici même. Une
    // session portant sur un sujet nouveau ne laissait sinon que deux issues —
    // la ranger dans une catégorie qui ne lui convient pas, ou la jeter.
    var neuve = document.createElement('button');
    neuve.type = 'button';
    neuve.className = 'categorie categorie-neuve';
    neuve.textContent = '+ Nouvelle';
    neuve.addEventListener('click', function () {
      el.finSaisie.hidden = false;
      el.finNouvelle.value = '';
      try { el.finNouvelle.focus(); } catch (err) { /* sans gravité */ }
    });
    el.finChoix.appendChild(neuve);
  }

  /**
   * Crée la catégorie saisie, ou retrouve celle qui porte déjà ce nom, puis
   * compte la session dessus.
   *
   * Retrouver plutôt que créer n'est pas un détail : deux catégories de même
   * nom couperaient l'historique en deux sans que rien ne le signale.
   */
  function creerEtCompter() {
    // La question ne se pose qu'après un chronomètre : la catégorie créée là
    // se compte forcément en temps.
    var connue = creerCategorie(el.finNouvelle.value, 'temps');
    if (!connue) return;
    el.finSaisie.hidden = true;
    el.finNouvelle.value = '';
    compter(connue);
  }

  /*
   * Le journal tel que le moteur doit le voir : **par identifiant**, et amputé
   * des catégories supprimées.
   *
   * DEUX DÉFAUTS RÉGLÉS ICI, ET C'ÉTAIT LE MÊME. On passait au moteur un
   * journal où l'identifiant était remplacé par le libellé, pour qu'il agrège
   * sous un nom lisible. Deux conséquences, toutes deux constatées :
   *
   * — une catégorie supprimée disparaissait des tuiles mais **continuait de
   *   compter** dans la progression, puisque ses entrées portaient toujours son
   *   nom et que rien ne disait qu'elle n'existait plus ;
   * — recréer une catégorie du même nom lui rendait **tout l'historique de
   *   l'ancienne** : elle naissait avec un total, ce qui ressemblait fort à un
   *   compteur initialisé de travers.
   *
   * L'identifiant, lui, ne se recycle jamais. Le libellé n'est plus qu'un
   * affichage, ce qu'il aurait dû rester : renommer ne coupe toujours pas
   * l'historique, et deux catégories homonymes ne se confondent plus.
   */
  function journalVivant() {
    return journal.filter(function (e) {
      var c = categorieDe(e.categorie);
      // Une entrée dont la catégorie est inconnue est gardée : elle vient
      // probablement d'un appareil dont les catégories n'ont pas encore été
      // synchronisées, et la faire disparaître serait pire que l'afficher mal.
      return !c || !c.supprime;
    });
  }

  function compter(categorie) {
    if (!attente.length) return;
    var session = attente[0];
    // La file d'attente vient toujours d'un chronomètre : sa valeur est un
    // temps, converti en minutes — l'unité dans laquelle le moteur compte.
    var entree = S.creer(identifiant(), session.debut,
                         session.dureeMs / S.MS_MINUTE, categorie.id);
    if (entree) {
      entree.sale = true;
      journal.push(entree);
      ecrire(CLE_JOURNAL, journal);
      prevenir();
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
  el.finCreer.addEventListener('click', creerEtCompter);
  el.finNouvelle.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); creerEtCompter(); }
  });

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

  /**
   * « 3h21 », « 45m ». La forme longue de `formatDuree` — « 3 h 21 » — ne tient
   * pas dans une colonne large d'un septième de panneau : elle y reviendrait à
   * la ligne, ou déborderait sur sa voisine.
   */
  function compact(ms) {
    var minutes = Math.round(ms / S.MS_MINUTE);
    var heures = Math.floor(minutes / 60);
    var reste = minutes % 60;
    if (!heures) return minutes + 'm';
    if (!reste) return heures + 'h';
    return heures + 'h' + (reste < 10 ? '0' : '') + reste;
  }

  function dessinerProgression() {
    vider(el.progCorps);
    if (vueProgression === 'categories') { el.progTitre.textContent = 'Catégories'; dessinerCategories(); return; }
    if (vueProgression === 'synchro') { el.progTitre.textContent = 'Synchronisation'; dessinerSynchro(); return; }
    el.progTitre.textContent = 'Progression';

    var agr = bilan();

    if (!agr.sessions) {
      el.progCorps.appendChild(elem('p', 'vide',
        'Rien de compté pour l\'instant. À la fin d\'un minuteur, ou quand tu ' +
        'remets le chronomètre à zéro, on te demandera sur quoi tu as travaillé.'));
      return;
    }

    // Les trois totaux de temps sont en minutes, et ne comptent que les
    // catégories mesurées en temps : additionner des séances de muscu à des
    // heures de SQL ne donnerait pas un total plus riche, mais un nombre qui
    // n'a pas de sens et qui aurait l'air d'en avoir un.
    var totaux = elem('div', 'totaux');
    [['Aujourd\'hui', S.formatDuree(agr.jour * S.MS_MINUTE)],
     ['Cette semaine', S.formatDuree(agr.semaine * S.MS_MINUTE)],
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
                          S.formatEffort(agr.global.mois)));
    cote.appendChild(jauge(agr.global.fraction));
    // Le reste général s'exprime en pourcentage, et non en heures : il
    // additionne des progressions d'unités différentes — dix heures de SQL et
    // vingt séances de muscu valent chacune un point. Le dire en heures serait
    // faux dès la deuxième catégorie.
    cote.appendChild(elem('div', 'general-reste',
      Math.round(agr.global.fraction * 100) + ' % du niveau ' +
      (agr.global.niveau + 1) + ' · ' +
      S.formatDuree(agr.total * S.MS_MINUTE) + ' chronométrées'));
    general.appendChild(cote);
    el.progCorps.appendChild(general);

    // Sept derniers jours.
    var maxi = agr.jours.reduce(function (m, j) { return Math.max(m, j.ms); }, 0);
    var semaine = elem('div', 'semaine');
    var LETTRES = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
    agr.jours.forEach(function (j) {
      var colonne = elem('div', 'barre-jour' + (j.ms > 0 ? ' travaille' : ''));
      // La durée au-dessus de la barre. Sept rectangles nus se comparent entre
      // eux, mais ne disent jamais combien : c'est pourtant la seule question
      // qu'on pose à un tel graphique.
      colonne.appendChild(elem('b', null, j.ms > 0 ? compact(j.ms) : '·'));
      var fut = elem('div', 'fut');
      var barre = elem('i');
      // Une part de la plus longue journée : l'échelle absolue rendrait toutes
      // les colonnes minuscules dès qu'une journée sort du lot.
      barre.style.height = (maxi > 0 ? Math.max(3, Math.round(100 * j.ms / maxi)) : 3) + '%';
      fut.appendChild(barre);
      colonne.appendChild(fut);
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
      tete.appendChild(elem('span', 'ligne-nom', nomDe(c.categorie)));
      tete.appendChild(elem('span', 'ligne-temps',
                           S.formatValeur(c.valeur, c.unite)));
      corps.appendChild(tete);
      corps.appendChild(jauge(c.niveau.fraction));
      corps.appendChild(elem('div', 'ligne-pied',
        'Niveau ' + c.niveau.niveau + ' · ' +
        S.formatValeur(c.niveau.pourSuivant, c.unite) +
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

  //: Le libellé de chaque unité, et le geste qu'elle implique. L'ordre est
  //: celui de leur fréquence : la plupart des catégories se comptent en fois.
  var LIBELLES_UNITE = [
    ['fois', 'Fois'],
    ['temps', 'Temps'],
    ['distance', 'Kilomètres']
  ];

  /**
   * Le choix d'unité d'une catégorie : trois boutons, un seul actif.
   *
   * Un menu déroulant tiendrait moins de place, mais demanderait deux gestes
   * pour lire ce qui est réglé — alors qu'ici l'état se voit sans rien ouvrir.
   */
  function choixUnite(categorie, apres) {
    var barre = elem('div', 'unites');
    LIBELLES_UNITE.forEach(function (paire) {
      var actuelle = S.UNITES[categorie.unite] ? categorie.unite : S.UNITE_DEFAUT;
      var bouton = elem('button', 'unite' + (paire[0] === actuelle ? ' active' : ''),
                        paire[1]);
      bouton.type = 'button';
      bouton.addEventListener('click', function () {
        if (categorie.unite === paire[0]) return;
        categorie.unite = paire[0];
        // Le coût repart au défaut de la nouvelle unité : garder « 600 » en
        // passant du temps aux fois demanderait six cents séances par niveau.
        categorie.cout = null;
        categorie.majA = Date.now();
        categorie.sale = true;
        ecrire(CLE_CATEGORIES, categories);
        if (apres) apres();
      });
      barre.appendChild(bouton);
    });
    return barre;
  }

  /**
   * Le rythme visé d'une catégorie, et ce qu'il coûte par niveau.
   *
   * On demande le rythme, jamais le coût : « combien d'heures vaut un niveau »
   * n'a pas de réponse — personne ne raisonne ainsi. « Combien de fois par
   * semaine je vise » en a une, immédiate, et le coût s'en déduit.
   *
   * `compte` sert à l'avertissement : relever un coût fait **redescendre** un
   * niveau déjà atteint. C'est acceptable quand on l'a décidé, jamais quand on
   * le découvre — le niveau à venir est donc annoncé avant d'appliquer.
   */
  function reglageRythme(categorie, compte) {
    var boite = elem('div', 'rythme');
    var reglage = S.reglageDe(categorie.id, reglages());
    var infos = S.UNITES[reglage.unite];

    var champ = document.createElement('input');
    champ.type = 'number';
    champ.min = '0';
    champ.step = String(infos.pas);
    champ.inputMode = 'decimal';
    champ.className = 'rythme-champ';
    champ.value = String(Math.round(
      S.rythmePourCout(reglage.cout, reglage.unite) * 100) / 100);

    var suffixe = elem('span', 'rythme-suffixe', infos.parSemaine);
    var resume = elem('span', 'rythme-resume', '');

    function apercu() {
      var futur = S.coutPourRythme(champ.value, reglage.unite) || reglage.cout;
      var texte = S.coutLisible(futur, reglage.unite);
      // Le niveau que ce coût donnerait, s'il change celui d'aujourd'hui.
      if (compte) {
        var apres = S.niveauPour(compte.valeur, futur).niveau;
        if (apres !== compte.niveau.niveau) {
          texte += ' · niveau ' + compte.niveau.niveau + ' → ' + apres;
        }
      }
      resume.textContent = texte;
    }

    function appliquer() {
      var futur = S.coutPourRythme(champ.value, reglage.unite);
      if (!futur) { champ.value = String(S.rythmePourCout(reglage.cout, reglage.unite)); return; }
      if (futur === categorie.cout) return;
      categorie.cout = futur;
      categorie.majA = Date.now();
      categorie.sale = true;
      ecrire(CLE_CATEGORIES, categories);
      prevenir();
      synchroniser();
      dessinerProgression();
    }

    champ.addEventListener('input', apercu);
    champ.addEventListener('change', appliquer);
    apercu();

    boite.appendChild(elem('span', 'rythme-nom', 'Rythme visé'));
    boite.appendChild(champ);
    boite.appendChild(suffixe);
    boite.appendChild(resume);
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
      if (!creerCategorie(champ.value, 'temps')) return;
      synchroniser();
      champ.value = '';
      dessinerProgression();
    }
    ajout.addEventListener('click', ajouter);
    champ.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); ajouter(); }
    });

    var lignes = elem('div', 'lignes');
    var agr = bilan();
    var parId = {};
    agr.categories.forEach(function (c) { parId[c.categorie] = c; });

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

      var compte = parId[categorie.id];
      tete.appendChild(elem('span', 'ligne-temps',
        compte ? S.formatValeur(compte.valeur, compte.unite) : '—'));

      /*
       * SUPPRIMER DEMANDE DEUX GESTES. Une croix de quelques millimètres, à
       * côté d'un champ de texte qu'on vient d'éditer, s'atteint par mégarde —
       * et le geste était immédiat et définitif. La croix devient donc une
       * question, et redevient une croix si on ne répond pas : rien à annuler,
       * rien à confirmer quand on ne voulait rien supprimer.
       */
      var retirer = elem('button', 'retirer', '×');
      retirer.setAttribute('aria-label', 'Retirer ' + categorie.nom);
      var attenteConfirmation = null;

      function rendreLaCroix() {
        if (attenteConfirmation) clearTimeout(attenteConfirmation);
        attenteConfirmation = null;
        retirer.className = 'retirer';
        retirer.textContent = '×';
      }

      retirer.addEventListener('click', function () {
        if (!attenteConfirmation) {
          retirer.className = 'retirer retirer-confirme';
          retirer.textContent = 'Supprimer ?';
          attenteConfirmation = setTimeout(rendreLaCroix, DELAI_CONFIRMATION_MS);
          return;
        }
        rendreLaCroix();
        categorie.supprime = true;
        categorie.majA = Date.now();
        categorie.sale = true;
        ecrire(CLE_CATEGORIES, categories);
        prevenir();
        synchroniser();
        dessinerProgression();
      });
      tete.appendChild(retirer);
      ligne.appendChild(tete);
      ligne.appendChild(choixUnite(categorie, function () {
        synchroniser();
        dessinerProgression();
      }));
      ligne.appendChild(reglageRythme(categorie, compte));
      lignes.appendChild(ligne);
    });
    el.progCorps.appendChild(lignes);

    el.progCorps.appendChild(elem('p', 'note',
      'Retirer une catégorie retire aussi ce qu’elle avait compté des totaux ' +
      'et des niveaux. Les entrées restent dans le journal, mais elles ne ' +
      'comptent plus, et recréer une catégorie du même nom repart de zéro. ' +
      'Renommer, en revanche, ne coupe rien — le journal retient l’identifiant, ' +
      'pas le libellé. Changer d’unité, en revanche, relit tout l’historique de la ' +
      'catégorie dans la nouvelle : à ne faire que sur une catégorie encore vide.'));
  }

  // ── Synchronisation ─────────────────────────────────────────────────────

  var etatSync = cfg ? 'attente' : 'absente';
  var enCours = false;
  //: La cause de la dernière panne, en clair. Sans elle, un échec se constate
  //: mais ne se répare pas : la console d'un téléphone n'est pas consultable.
  var raisonSync = '';

  /**
   * Accepte le code sous ses deux formes : le base64 de TaskMint, ou le contenu
   * brut de son `sync.json`. Les deux portent les mêmes trois valeurs, et rien
   * ne se gagne à exiger l'une plutôt que l'autre.
   */
  function lireCode(brut) {
    var texte = String(brut || '').trim();
    if (!texte) throw new Error('le champ est vide');
    var lu;
    try { lu = JSON.parse(texte); }
    catch (err) {
      try { lu = JSON.parse(atob(texte.replace(/\s+/g, ''))); }
      catch (err2) { throw new Error('ce n’est ni le code de TaskMint, ni le contenu de sync.json'); }
    }
    var manque = ['u', 'k', 's'].filter(function (c) { return !lu[c]; });
    if (manque.length) {
      // Le cas courant : n'avoir collé que le secret. Le code en porte trois.
      throw new Error('code incomplet, il manque « ' + manque.join(' », « ') +
                      ' » — le code porte l’adresse (u), la clé (k) et le secret (s)');
    }
    return { u: String(lu.u).replace(/\/+$/, ''),
             k: String(lu.k), s: String(lu.s) };
  }

  /**
   * Traduit l'échec d'un appel en une phrase qui dit quoi faire. Un « 401 » nu
   * n'apprend rien à qui n'écrit pas de requêtes HTTP.
   */
  function enClair(err) {
    var texte = String((err && err.message) || err || '');
    if (/(401|403)/.test(texte)) {
      return 'la base a refusé le code (' + texte + ') — secret ou clé erronés.';
    }
    if (/404/.test(texte)) {
      return 'table absente (' + texte + ') — le script SUPABASE.sql n’a pas été ' +
             'lancé sur ce projet.';
    }
    // PostgREST nomme la colonne qu'il ne trouve pas : c'est le symptôme exact
    // d'une base restée en arrière d'une version de l'application.
    if (/400/.test(texte) || /column/i.test(texte)) {
      return 'la base n’a pas toutes les colonnes attendues (' + texte + ') — ' +
             'lance SUPABASE-progression.sql dans Supabase.';
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(texte)) {
      return 'la base n’a pas répondu — réseau coupé, ou adresse erronée.';
    }
    return texte;
  }

  function dessinerSynchro() {
    var etat = elem('div', 'etat-synchro' +
      (etatSync === 'ok' ? ' ok' : (etatSync === 'panne' ? ' panne' : '')));
    etat.appendChild(elem('i'));
    etat.appendChild(elem('span', null, {
      absente: 'Aucun appareil couplé — ce suivi ne vit que sur ce téléphone.',
      attente: 'Couplé, synchronisation en attente.',
      ok: 'Couplé et à jour.',
      panne: 'Couplé, mais la dernière synchronisation a échoué.',
      // Un code refusé ne couple rien : dire « couplé » ici envoyait chercher
      // la panne du côté du réseau, alors qu'elle était dans le champ.
      refus: 'Code refusé — cet appareil n’est pas couplé.'
    }[etatSync] || etatSync));
    el.progCorps.appendChild(etat);
    if (raisonSync) el.progCorps.appendChild(elem('p', 'note', raisonSync));

    // La version installée, en tête du panneau. « Suis-je à jour ? » n'avait
    // aucune réponse dans l'application : on comparait des symptômes, et une
    // version périmée se confondait avec un défaut de calcul.
    var balise = document.querySelector('meta[name="chrono-version"]');
    var version = balise ? balise.getAttribute('content') : null;
    el.progCorps.appendChild(elem('p', 'note',
      'Version installée : ' + (version && version.indexOf('_') < 0
        ? version : 'inconnue (page non construite)')));

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
        cfg = lireCode(champ.value);
        ecrire(CLE_SYNC, cfg);
        etatSync = 'attente';
        raisonSync = '';
        champ.value = '';
        synchroniser();
        dessinerProgression();
      } catch (err) {
        logErreur('code de synchro illisible', err);
        etatSync = 'refus';
        raisonSync = enClair(err);
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
        raisonSync = '';
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

    // Comparaison sur la plus grande dimension : en paysage, certains
    // navigateurs échangent largeur et hauteur d'écran, d'autres non. Prendre
    // le maximum des deux évite d'avoir à savoir lequel on a en face.
    var vue = Math.max(window.innerWidth, window.innerHeight);
    var ecran = window.screen
      ? Math.max(window.screen.width, window.screen.height) : vue;
    var manque = Math.round(ecran - vue);

    el.progCorps.appendChild(elem('p', 'note',
      'Affichage : ' + window.innerWidth + ' × ' + window.innerHeight +
      ' points, densité ' + (window.devicePixelRatio || 1) +
      ' · zones sûres haut/droite/bas/gauche : ' + marges.join(' / ') + ' px' +
      ' · écran ' + (window.screen ? window.screen.width + ' × ' +
                     window.screen.height : '?') + '.'));

    // Le verdict, en clair. C'est lui qui dit si un décalage se corrige ici ou
    // dans les réglages du téléphone — et les deux ne se ressemblent pas.
    //
    // Il n'a de sens qu'en plein écran : dans une fenêtre de navigateur, une
    // vue plus étroite que l'écran est la situation normale, et l'annoncer
    // comme une bande réservée serait une fausse alerte.
    function pleinEcran() {
      try {
        return window.matchMedia('(display-mode: fullscreen)').matches ||
               window.matchMedia('(display-mode: standalone)').matches ||
               !!document.fullscreenElement;
      } catch (err) { return false; }
    }

    el.progCorps.appendChild(elem('p', 'note',
      !pleinEcran()
        ? 'Fenêtre de navigateur : la vue ne couvre pas l’écran, c’est normal. ' +
          'Ce diagnostic ne vaut que dans l’application installée, ouverte ' +
          'depuis son icône.'
        : manque > 4
        ? 'Le système réserve ' + manque + ' points sur le côté : la vue est ' +
          'plus étroite que l’écran, et l’application ne peut rien y peindre. ' +
          'Cela se règle dans les réglages d’affichage du téléphone (affichage ' +
          'plein écran, application par application), pas dans la page — qui ' +
          'demande déjà le plein écran et l’extension sous l’encoche.'
        : 'La vue occupe tout l’écran : un décalage éventuel se corrige ici, ' +
          'avec le réglage de centrage ci-dessous.'));

    // ── L’heure en petit ────────────────────────────────────────────
    var bascule = elem('div', 'bascule');
    var interrupteur = elem('button', 'interrupteur');
    interrupteur.type = 'button';
    interrupteur.appendChild(elem('i'));

    function lireHeureCoin() {
      try { return localStorage.getItem('chrono_pwa_heure_coin') !== '0'; }
      catch (err) { return true; }
    }

    function peindreInterrupteur() {
      var actif = lireHeureCoin();
      interrupteur.classList.toggle('actif', actif);
      interrupteur.setAttribute('aria-pressed', actif ? 'true' : 'false');
    }

    interrupteur.setAttribute('aria-label', 'Afficher l’heure en petit');
    interrupteur.addEventListener('click', function () {
      try {
        localStorage.setItem('chrono_pwa_heure_coin', lireHeureCoin() ? '0' : '1');
      } catch (err) {
        logErreur('écrire l’heure en coin', err);
      }
      peindreInterrupteur();
      if (window.ChronoAffichage) window.ChronoAffichage.majHeureCoin();
    });

    bascule.appendChild(elem('span', 'bascule-nom', 'Heure en petit dans le coin'));
    bascule.appendChild(interrupteur);
    el.progCorps.appendChild(bascule);
    peindreInterrupteur();

    el.progCorps.appendChild(elem('p', 'note',
      'Elle paraît en chronomètre et en minuteur, jamais en vue horloge — elle ' +
      'y ferait doublon. Elle ne s’efface pas avec les commandes : c’est une ' +
      'information qu’on vient lire, pas un bouton dont on se passe.'));

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

  /*
   * `duree_ms` EST ENCORE ÉCRIT, ET C'EST VOULU. La colonne est obligatoire, et
   * un appareil resté en ancienne version ne connaît qu'elle. On y met donc le
   * temps quand c'en est, et **zéro** pour une séance ou des kilomètres — que
   * l'ancien code écarte déjà comme une durée invalide. Il ignore ainsi ce
   * qu'il ne saurait pas afficher, au lieu de compter une séance de muscu pour
   * zéro minute de travail.
   */
  function versDistant(table, lignes) {
    if (table === TABLE_SESSIONS) {
      return lignes.map(function (e) {
        var temps = uniteDe(e.categorie) === 'temps';
        return { id: e.id, debut: e.debut,
                 valeur: e.valeur,
                 duree_ms: temps ? Math.round(e.valeur * S.MS_MINUTE) : 0,
                 categorie: e.categorie, supprime: !!e.supprime, maj_a: e.majA };
      });
    }
    return lignes.map(function (c) {
      return { id: c.id, nom: c.nom, unite: c.unite || null, cout: c.cout || null,
               supprime: !!c.supprime, maj_a: c.majA };
    });
  }

  function depuisDistant(table, lignes) {
    if (table === TABLE_SESSIONS) {
      return lignes.map(function (r) {
        var valeur = parseFloat(r.valeur);
        // Une ligne écrite avant que l'unité existe n'a pas de `valeur` : sa
        // durée en millisecondes en tient lieu.
        if (!isFinite(valeur) || valeur <= 0) valeur = Number(r.duree_ms) / S.MS_MINUTE;
        return { id: r.id, debut: Number(r.debut), valeur: valeur,
                 categorie: r.categorie, supprime: !!r.supprime,
                 majA: Number(r.maj_a), sale: false };
      });
    }
    return lignes.map(function (r) {
      return { id: r.id, nom: r.nom,
               unite: S.UNITES[r.unite] ? r.unite : S.UNITE_DEFAUT,
               cout: isFinite(parseFloat(r.cout)) ? parseFloat(r.cout) : null,
               supprime: !!r.supprime, majA: Number(r.maj_a), sale: false };
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

  /**
   * Le motif d'un refus, tel que la base le donne.
   *
   * Un « 400 » nu ne dit rien ; le corps de la réponse, lui, nomme la colonne
   * manquante ou la contrainte violée. C'est la seule information qui permette
   * de réparer sans brancher un ordinateur sur le téléphone.
   */
  async function motif(reponse) {
    try {
      var texte = await reponse.text();
      var lu = JSON.parse(texte);
      return lu.message || lu.hint || texte.slice(0, 120);
    } catch (err) {
      return '';
    }
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
      if (!envoi.ok) {
        throw new Error('envoi ' + table + ' : ' + envoi.status + ' — ' +
                        await motif(envoi));
      }
      sales.forEach(function (l) { l.sale = false; });
    }
    var lecture = await fetch(cfg.u + '/rest/v1/' + table + '?select=*',
                              { headers: entetes() });
    if (!lecture.ok) {
      throw new Error('lecture ' + table + ' : ' + lecture.status + ' — ' +
                      await motif(lecture));
    }
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
      raisonSync = '';
      prevenir();
      // Maintenant seulement : on sait ce que les autres appareils ont déjà.
      if (!categoriesVives().length) { amorcer(); ecrire(CLE_CATEGORIES, categories); }
      if (!el.voileProg.hidden) dessinerProgression();
    } catch (err) {
      // Une panne de synchro n'empêche jamais de compter son temps : le journal
      // local reste la source, et le prochain cycle rattrapera.
      logErreur('synchroniser', err);
      etatSync = 'panne';
      raisonSync = enClair(err);
      if (!el.voileProg.hidden) dessinerProgression();
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

  /*
   * Ce que la face portrait consomme.
   *
   * Elle ne touche ni au stockage ni au réseau : elle demande un état, elle
   * pose un geste. Deux fichiers qui écriraient tous deux dans `localStorage`
   * finiraient par s'écraser l'un l'autre — et le journal est la seule chose
   * qu'on ne peut pas se permettre de perdre.
   */
  function prevenir() {
    abonnes.forEach(function (fn) {
      try { fn(); } catch (err) { logErreur('abonné', err); }
    });
  }

  /** L'état complet du tableau : les catégories vivantes, garnies de leur bilan. */
  function etat() {
    var agr = bilan();
    var parId = {};
    agr.categories.forEach(function (c) { parId[c.categorie] = c; });
    return {
      global: agr.global,
      serie: agr.serie,
      jour: agr.jour,
      total: agr.total,
      sessions: agr.sessions,
      categories: categoriesVives().map(function (c) {
        var compte = parId[c.id];
        var reglage = S.reglageDe(c.id, reglages());
        return {
          id: c.id, nom: c.nom, unite: reglage.unite, cout: reglage.cout,
          valeur: compte ? compte.valeur : 0,
          aujourdhui: compte ? compte.aujourdhui : 0,
          niveau: compte ? compte.niveau : S.niveauPour(0, reglage.cout)
        };
      })
    };
  }

  /**
   * Compte `valeur` de plus sur une catégorie, tout de suite.
   *
   * Écrit avant de rendre la main, et rend l'identifiant de l'entrée : c'est
   * lui qui permet d'annuler. Le geste doit être acquis même si la page
   * disparaît dans la seconde — un `+1` perdu est exactement ce qui fait
   * abandonner ce genre d'outil.
   */
  function ajouterEntree(idCategorie, valeur) {
    var categorie = categorieDe(idCategorie);
    if (!categorie || categorie.supprime) return null;
    var entree = S.creer(identifiant(), Date.now(), valeur, categorie.id);
    if (!entree) return null;
    entree.sale = true;
    journal.push(entree);
    ecrire(CLE_JOURNAL, journal);
    prevenir();
    synchroniser();
    return entree.id;
  }

  /**
   * Défait une entrée. Marquée supprimée, jamais effacée : la suppression doit
   * atteindre les autres appareils, et une ligne absente ne se propage pas.
   */
  function retirerEntree(id) {
    var connue = journal.filter(function (e) { return e.id === id; })[0];
    if (!connue) return false;
    journal = S.supprimer(journal, id, Date.now());
    journal.forEach(function (e) { if (e.id === id) e.sale = true; });
    ecrire(CLE_JOURNAL, journal);
    prevenir();
    synchroniser();
    return true;
  }

  /**
   * Les dernières entrées d'une catégorie, de la plus récente à la plus
   * ancienne. Les supprimées sont écartées : elles n'existent que pour que la
   * suppression atteigne les autres appareils.
   */
  function entreesDe(idCategorie, limite) {
    return journal
      .filter(function (e) {
        return e.categorie === idCategorie && !e.supprime;
      })
      .map(function (e) {
        return { id: e.id, quand: e.debut, valeur: e.valeur };
      })
      .sort(function (a, b) { return b.quand - a.quand; })
      .slice(0, limite || 20);
  }

  window.SuiviUI = {
    proposer: proposer,
    ouvrirProgression: ouvrirProgression,
    ouvrirSynchro: ouvrirSynchro,
    fermer: function () { fermerFin(); fermerProgression(); },
    ouvert: ouvert,
    // ── Ce que consomme la face portrait ──
    etat: etat,
    entrees: entreesDe,
    ajouter: ajouterEntree,
    retirer: retirerEntree,
    creerCategorie: function (nom, unite, cout) {
      var c = creerCategorie(nom, unite, cout);
      if (c) { prevenir(); synchroniser(); }
      return c;
    },
    unites: LIBELLES_UNITE,
    abonner: function (fn) { abonnes.push(fn); },
    // Exposés pour les tests, qui doivent pouvoir observer sans passer par le
    // stockage : lire `localStorage` ne dirait rien de ce qui est affiché.
    _journal: function () { return journal; },
    _attente: function () { return attente; },
    _categories: function () { return categories; }
  };
})();
