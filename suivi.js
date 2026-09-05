/*
 * Suivi des progressions — moteur pur, sans DOM ni réseau.
 *
 * Même parti pris que `timer.js`, et pour les mêmes raisons : tout ce qui se
 * calcule est calculé, rien n'est entretenu en double. Le seul état conservé
 * est le **journal des entrées** ; les totaux, les niveaux et les séries en
 * sont dérivés à chaque lecture. Un compteur « total du jour » rangé à côté
 * finirait par diverger de ses propres données — au premier fuseau franchi, à
 * la première entrée corrigée, à la première synchro partielle.
 *
 * UNE ENTRÉE PORTE UNE VALEUR, PAS UNE DURÉE. L'unité — des minutes, des fois,
 * des kilomètres — vit sur la **catégorie**, jamais sur l'entrée. Ce n'est pas
 * un détail d'écriture : c'est ce qui permet d'ajouter une unité sans toucher
 * au calcul. Une unité ne fait que deux choses, mettre en forme un nombre et
 * choisir un geste de saisie ; un niveau, lui, coûte *N unités*, que N soit des
 * minutes ou des séances.
 *
 * Le module est chargeable en Node, donc éprouvable sans navigateur ni
 * appareil : `tests/suivi.test.js`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SuiviTravail = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MS_MINUTE = 60000;

  /*
   * Échelle des niveaux : le niveau n s'atteint à **`coût × (n − 1)²`**.
   *
   * L'échelle a d'abord été linéaire, et c'était une erreur de cadrage. Le
   * raisonnement tenait — une progression régulière se prévoit de tête, et dix
   * heures de plus valent autant au niveau 3 qu'au niveau 12 — mais il supposait
   * une échelle sans fin. Or il y a **dix blasons**, et pas un de plus : les dix
   * marches doivent donc couvrir une pratique entière, pas dix mois. Avec un
   * palier constant, un an et demi de salle atteignait le niveau 27 et plafonnait
   * le dernier blason avant d'avoir commencé à vouloir dire quelque chose.
   *
   * Le carré place les marches là où il faut : le niveau 2 après un mois de
   * rythme tenu, le 5 après seize mois, le 10 après **six ans et neuf mois**.
   * Le premier palier garde donc exactement le sens que lui donne le rythme
   * visé, et le dernier redevient une distinction.
   *
   * L'objection d'origine — les hauts niveaux deviennent lents — est vraie, et
   * c'est le prix d'une échelle bornée. Elle est atténuée par la jauge, qui
   * montre la progression **dans** le niveau, et par le total, qui continue de
   * monter en ligne droite.
   *
   * Chaque unité porte son coût de niveau par défaut, le libellé de son rythme,
   * et le rythme hebdomadaire qu'on propose à la création.
   *
   * `cout` est ce qu'appliquent les catégories qui n'ont jamais été réglées.
   * Il reste à sa valeur d'origine et n'a pas suivi les rythmes proposés
   * ci-dessous : le relever aurait fait **redescendre** des niveaux déjà
   * atteints, en silence et sans que personne l'ait demandé.
   */
  var UNITES = {
    //: La valeur d'une entrée est en MINUTES ; l'objectif, lui, se dit en
    //: heures — personne ne se fixe « douze mille minutes ».
    temps: { cout: 600, objectif: 200, suffixe: 'h au niveau 10', pas: 5 },
    fois: { cout: 20, objectif: 1000, suffixe: 'fois au niveau 10', pas: 10 },
    distance: { cout: 200, objectif: 10000, suffixe: 'km au niveau 10', pas: 100 }
  };

  /*
   * L'ÉCHELLE S'ANCRE SUR LE NIVEAU 10, PAS SUR LE PREMIER PALIER.
   *
   * « Combien vaut un niveau ? » n'a pas de réponse — personne ne raisonne
   * ainsi. « Qu'est-ce que la maîtrise, ici ? » en a une, immédiate : mille
   * séances de salle, quarante heures de préparation d'entretien. Et ces deux
   * réponses n'ont aucun rapport d'échelle entre elles, ce qui est exactement
   * la raison pour laquelle un réglage commun ne pouvait pas convenir.
   *
   * Le coût du premier palier s'en déduit : le niveau 10 étant à `coût × 81`,
   * l'objectif divisé par 81 donne le coût. Tout le reste de la courbe suit.
   */

  /** Le coût d'un palier, pour un objectif de niveau 10. */
  function coutPourObjectif(objectif, unite) {
    var o = Math.max(0, parseFloat(objectif) || 0);
    if (!o) return null;
    // Le temps se vise en heures et se compte en minutes.
    var parUnite = (unite === 'temps') ? 60 : 1;
    return o * parUnite / seuil(10, 1);
  }

  /** L'objectif de niveau 10 qu'implique un coût de palier. */
  function objectifPourCout(cout, unite) {
    var c = Math.max(0, parseFloat(cout) || 0);
    if (!c) return 0;
    var parUnite = (unite === 'temps') ? 60 : 1;
    return c * seuil(10, 1) / parUnite;
  }

  /**
   * Les premières marches, une fois l'objectif posé.
   *
   * L'objectif dit où l'on va ; il ne dit pas si le début est atteignable.
   * « Niveau 2 à 12 fois, niveau 5 à 198 » répond à la seule question qui
   * reste : à quoi ressemblent les premiers paliers.
   */
  function coutLisible(cout, unite) {
    return 'niveau 2 à ' + formatValeur(seuil(2, cout), unite) +
           ' · niveau 5 à ' + formatValeur(seuil(5, cout), unite);
  }

  var UNITE_DEFAUT = 'temps';

  //: Compatibilité : le coût d'un niveau de temps, sous son ancien nom.
  var BASE_CATEGORIE = UNITES.temps.cout;

  /**
   * L'unité et le coût d'une catégorie, quoi qu'on nous ait passé.
   *
   * Les réglages viennent du stockage d'un appareil ou d'une table distante :
   * une unité inconnue ou un coût nul rendraient tous les niveaux infinis sans
   * que rien ne le signale. On retombe sur le temps, qui est ce qu'étaient
   * toutes les catégories avant que l'unité existe.
   */
  function reglageDe(nom, reglages) {
    var brut = (reglages && reglages[nom]) || {};
    var unite = UNITES[brut.unite] ? brut.unite : UNITE_DEFAUT;
    var cout = parseFloat(brut.cout);
    if (!isFinite(cout) || cout <= 0) cout = UNITES[unite].cout;
    return { unite: unite, cout: cout };
  }

  //: L'exposant de l'échelle. Deux : le seul qui se raconte en une phrase —
  //: « le niveau n coûte (n−1) mois de rythme » — et qui place le dixième
  //: blason à près de sept ans de pratique.
  var EXPOSANT = 2;

  /** Valeur cumulée nécessaire pour atteindre `niveau`. Le niveau 1 est à 0. */
  function seuil(niveau, cout) {
    return niveau <= 1 ? 0 : cout * Math.pow(niveau - 1, EXPOSANT);
  }

  /**
   * Niveau atteint avec `valeur`, et ce qu'il reste avant le suivant.
   *
   * Résolu par recherche montante plutôt que par une division : sur un seuil
   * exact, `Math.floor` d'un quotient flottant bascule une fois sur deux du
   * mauvais côté — et les seuils sont précisément les valeurs qu'on regarde.
   */
  function niveauPour(valeur, cout) {
    var v = Math.max(0, valeur);
    var niveau = 1;
    while (seuil(niveau + 1, cout) <= v) niveau += 1;
    var bas = seuil(niveau, cout);
    var haut = seuil(niveau + 1, cout);
    var dans = v - bas;
    var largeur = haut - bas;
    return {
      niveau: niveau,
      dansNiveau: dans,
      pourSuivant: haut - v,
      // Ancien nom, conservé : les vues l'emploient pour dessiner une jauge.
      minutesDansNiveau: dans,
      minutesPourSuivant: haut - v,
      // Part du niveau parcourue, dans [0,1] : de quoi dessiner une jauge sans
      // refaire le calcul côté interface.
      fraction: largeur > 0 ? dans / largeur : 0
    };
  }

  // ── Entrées du journal ──────────────────────────────────────────────────

  /**
   * Ramène n'importe quel objet à une entrée valide, ou rend `null`.
   *
   * Les entrées viennent de deux sources qu'on ne contrôle pas entièrement : le
   * stockage local d'un appareil et une table distante. Une valeur absente ou
   * négative, une date illisible, une catégorie vide contamineraient tous les
   * totaux d'un `NaN` sans que rien ne le signale — les agrégats ne lèvent pas,
   * ils affichent.
   *
   * `dureeMs` est accepté en repli : c'est la forme qu'avaient toutes les
   * entrées avant que l'unité existe, et elles sont encore dans la base.
   */
  function normaliser(brut) {
    if (!brut || typeof brut !== 'object') return null;
    var debut = parseFloat(brut.debut);
    if (!isFinite(debut) || debut <= 0) return null;

    var valeur = parseFloat(brut.valeur);
    if (!isFinite(valeur) || valeur <= 0) {
      var duree = parseFloat(brut.dureeMs);
      if (!isFinite(duree) || duree <= 0) return null;
      valeur = duree / MS_MINUTE;
    }

    var categorie = typeof brut.categorie === 'string' ? brut.categorie.trim() : '';
    if (!categorie) return null;
    var id = typeof brut.id === 'string' && brut.id ? brut.id : null;
    if (!id) return null;
    return {
      id: id,
      debut: debut,
      valeur: valeur,
      categorie: categorie,
      supprime: brut.supprime === true,
      majA: isFinite(parseFloat(brut.majA)) ? parseFloat(brut.majA) : debut
    };
  }

  /** Les entrées exploitables d'un journal brut, les autres écartées. */
  function nettoyer(entrees) {
    if (!Array.isArray(entrees)) return [];
    var vues = {};
    var propres = [];
    entrees.forEach(function (brut) {
      var e = normaliser(brut);
      if (!e || e.supprime) return;
      // Une même entrée peut arriver deux fois d'une synchro interrompue : la
      // plus récemment modifiée fait foi, jamais les deux additionnées.
      var connue = vues[e.id];
      if (connue && connue.majA >= e.majA) return;
      if (connue) propres.splice(propres.indexOf(connue), 1);
      vues[e.id] = e;
      propres.push(e);
    });
    return propres;
  }

  // ── Dates ───────────────────────────────────────────────────────────────
  //
  // Toutes les journées sont **locales**. Un suivi se lit dans le fuseau où
  // l'on a vécu : une session de 23 h 30 appartient à sa soirée, pas au
  // lendemain UTC.

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** Clé de journée locale, « 2026-08-25 ». */
  function jourDe(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** Minuit local du jour contenant `ms`. */
  function minuit(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Minuit du lundi de la semaine contenant `ms`. */
  function debutSemaine(ms) {
    var d = new Date(minuit(ms));
    // getDay() rend 0 pour dimanche : la semaine commence le lundi.
    var recul = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - recul);
    return d.getTime();
  }

  // ── Agrégats ────────────────────────────────────────────────────────────

  /**
   * Les entrées comptées en temps, et elles seules.
   *
   * « Aujourd'hui : 3 h 21 » ne peut additionner que des minutes. Y verser une
   * séance de muscu ne donnerait pas un total plus riche, mais un nombre qui ne
   * veut rien dire — et qui aurait l'air d'en vouloir dire un.
   */
  function duTemps(entrees, reglages) {
    return entrees.filter(function (e) {
      return reglageDe(e.categorie, reglages).unite === 'temps';
    });
  }

  function totalDepuis(entrees, borne) {
    return entrees.reduce(function (somme, e) {
      return e.debut >= borne ? somme + e.valeur : somme;
    }, 0);
  }

  /** Valeur cumulée par catégorie, chacune dans son unité. */
  function parCategorie(entrees, reglages, maintenant) {
    var debutDuJour = minuit(isFinite(maintenant) ? maintenant : Date.now());
    var cumul = {};
    var duJour = {};
    entrees.forEach(function (e) {
      cumul[e.categorie] = (cumul[e.categorie] || 0) + e.valeur;
      if (e.debut >= debutDuJour) {
        duJour[e.categorie] = (duJour[e.categorie] || 0) + e.valeur;
      }
    });
    return Object.keys(cumul).map(function (cle) {
      var reglage = reglageDe(cle, reglages);
      return {
        categorie: cle,
        valeur: cumul[cle],
        aujourdhui: duJour[cle] || 0,
        unite: reglage.unite,
        cout: reglage.cout,
        // Ancien nom : la valeur d'une catégorie de temps, en millisecondes.
        ms: reglage.unite === 'temps' ? cumul[cle] * MS_MINUTE : 0,
        niveau: niveauPour(cumul[cle], reglage.cout)
      };
    }).sort(function (a, b) {
      // Des heures et des séances ne se comparent pas ; leurs niveaux, si.
      if (b.niveau.niveau !== a.niveau.niveau) return b.niveau.niveau - a.niveau.niveau;
      return b.niveau.fraction - a.niveau.fraction;
    });
  }

  //: Combien de catégories portent le niveau général. Trois piliers : assez
  //: pour exiger de l'équilibre, assez peu pour qu'une vie suffise à les tenir
  //: au plus haut.
  var PILIERS = 3;

  /**
   * Niveau général : la **moyenne des trois meilleures** progressions.
   *
   * Deux règles ont été essayées avant, et toutes deux disaient autre chose que
   * ce qu'on attend d'un « niveau général ».
   *
   * — Additionner les niveaux payait la largeur au prix de la profondeur :
   *   quatre catégories débutantes valaient seize mois de pratique.
   * — Additionner les efforts faisait du général un synonyme de la plus grosse
   *   catégorie : niveau 6 au général avec un seul 6 et trois catégories à 1.
   *
   * Une moyenne dit ce qu'on cherche — où j'en suis dans l'ensemble — mais la
   * moyenne de TOUTES punit le commencement : le jour où l'on crée une
   * catégorie, le général baisse. Une mécanique qui sanctionne le fait de se
   * lancer est exactement celle qui fait cesser d'ouvrir une application.
   *
   * N'en retenir que trois lève la sanction sans rien perdre : une catégorie
   * neuve n'entre au calcul que si elle dépasse la troisième, donc **créer ne
   * peut jamais faire baisser le général**. Et le niveau 10 reste atteignable —
   * il demande trois pratiques au sommet, non la totalité.
   *
   * Sur une catégorie unique, le général vaut le sien, dilué par les deux
   * places vides : c'est voulu. Un seul pilier ne fait pas un ensemble.
   */
  function niveauGlobal(categories) {
    var progressions = categories.map(function (c) {
      return (c.niveau.niveau - 1) + c.niveau.fraction;
    });
    // Les places non pourvues comptent pour zéro : sans cela, une première
    // catégorie donnerait d'emblée un général égal au sien.
    while (progressions.length < PILIERS) progressions.push(0);
    progressions.sort(function (a, b) { return b - a; });

    var retenues = progressions.slice(0, PILIERS);
    var moyenne = retenues.reduce(function (s, p) { return s + p; }, 0) / PILIERS;
    var entier = Math.floor(moyenne);

    var mois = categories.reduce(function (somme, c) {
      return somme + (c.cout > 0 ? c.valeur / c.cout : 0);
    }, 0);

    return {
      niveau: 1 + entier,
      piliers: PILIERS,
      // Les trois progressions retenues, dans l'ordre : c'est ce qui rend le
      // niveau vérifiable. Un général qu'on ne peut pas recalculer de tête ne
      // peut être ni confirmé ni contesté.
      retenues: retenues,
      // La moyenne retenue, et l'effort total — l'un explique le niveau, l'autre
      // dit ce qu'on a réellement fait.
      points: moyenne,
      mois: mois,
      fraction: moyenne - entier,
      pourSuivant: 1 - (moyenne - entier)
    };
  }

  /**
   * Jours consécutifs comptés, à rebours depuis aujourd'hui.
   *
   * La journée en cours ne rompt pas la série tant qu'elle est vide : à huit
   * heures du matin, personne n'a encore rien fait, et afficher « série
   * interrompue » serait faux autant que décourageant. On repart donc de la
   * veille si aujourd'hui ne compte aucune entrée.
   */
  function serie(entrees, maintenant) {
    var jours = {};
    entrees.forEach(function (e) { jours[jourDe(e.debut)] = true; });

    var curseur = minuit(maintenant);
    if (!jours[jourDe(curseur)]) curseur -= 86400000;

    var compte = 0;
    while (jours[jourDe(curseur)]) {
      compte += 1;
      // Retirer 24 h en millisecondes traverserait mal un changement d'heure :
      // on recule d'un jour de calendrier.
      var d = new Date(curseur);
      d.setDate(d.getDate() - 1);
      curseur = d.getTime();
    }
    return compte;
  }

  /** Valeur par jour sur les `nombre` derniers jours, du plus ancien au plus récent. */
  function derniersJours(entrees, maintenant, nombre) {
    var cumul = {};
    entrees.forEach(function (e) {
      var cle = jourDe(e.debut);
      cumul[cle] = (cumul[cle] || 0) + e.valeur;
    });
    var sortie = [];
    var d = new Date(minuit(maintenant));
    d.setDate(d.getDate() - (nombre - 1));
    for (var i = 0; i < nombre; i++) {
      var cle = jourDe(d.getTime());
      var valeur = cumul[cle] || 0;
      sortie.push({ jour: cle, valeur: valeur, ms: valeur * MS_MINUTE });
      d.setDate(d.getDate() + 1);
    }
    return sortie;
  }

  /**
   * Tout ce que les vues ont besoin de savoir, en une passe.
   *
   * `reglages` associe un libellé de catégorie à son unité et au coût d'un
   * niveau. Omis, tout est du temps — ce qu'étaient toutes les catégories
   * avant que l'unité existe.
   */
  function agregats(journal, maintenant, reglages) {
    var entrees = nettoyer(journal);
    var temps = duTemps(entrees, reglages);
    var categories = parCategorie(entrees, reglages, maintenant);
    return {
      sessions: entrees.length,
      // Les trois totaux de temps sont en MINUTES, et ne comptent que les
      // catégories mesurées en temps.
      jour: totalDepuis(temps, minuit(maintenant)),
      semaine: totalDepuis(temps, debutSemaine(maintenant)),
      total: temps.reduce(function (s, e) { return s + e.valeur; }, 0),
      categories: categories,
      global: niveauGlobal(categories),
      serie: serie(entrees, maintenant),
      jours: derniersJours(temps, maintenant, 7)
    };
  }

  // ── Écriture ────────────────────────────────────────────────────────────

  /**
   * Une nouvelle entrée. `id` est fourni par l'appelant : c'est lui qui sait
   * produire un identifiant unique (`crypto.randomUUID` dans le navigateur), et
   * ce module reste sans dépendance ni source d'aléa — donc rejouable à
   * l'identique dans un test.
   */
  function creer(id, debut, valeur, categorie) {
    return normaliser({
      id: id, debut: debut, valeur: valeur, categorie: categorie,
      supprime: false, majA: debut
    });
  }

  /** Marque une entrée supprimée, sans l'effacer : la synchro doit la propager. */
  function supprimer(journal, id, maintenant) {
    return journal.map(function (e) {
      if (e.id !== id) return e;
      var copie = {};
      Object.keys(e).forEach(function (cle) { copie[cle] = e[cle]; });
      copie.supprime = true;
      copie.majA = maintenant;
      return copie;
    });
  }

  // ── Mise en forme ───────────────────────────────────────────────────────

  /** « 3 h 21 », « 45 min », « 0 min ». Prend des millisecondes. */
  function formatDuree(ms) {
    var minutes = Math.round(Math.max(0, ms) / MS_MINUTE);
    var heures = Math.floor(minutes / 60);
    var reste = minutes % 60;
    if (!heures) return reste + ' min';
    return heures + ' h' + (reste ? ' ' + pad2(reste) : '');
  }

  /**
   * L'effort total, en mois de rythme visé : « 29 mois d'effort ».
   *
   * C'est l'unité commune du niveau général, et la seule façon de rendre ce
   * niveau vérifiable : sans elle, il tombe d'un calcul qu'on ne peut pas
   * refaire de tête, et un total qui surprend ne peut être ni confirmé ni
   * contesté.
   */
  function formatEffort(mois) {
    var m = Math.max(0, parseFloat(mois) || 0);
    if (m < 1) return Math.round(m * 30) + ' jours d’effort';
    if (m < 24) return Math.round(m) + ' mois d’effort';
    var annees = Math.floor(m / 12);
    var reste = Math.round(m - annees * 12);
    return annees + ' ans' + (reste ? ' ' + reste + ' mois' : '') + ' d’effort';
  }

  /** Une valeur dans son unité : « 3 h 21 », « 12 fois », « 43 km ». */
  function formatValeur(valeur, unite) {
    var v = Math.max(0, parseFloat(valeur) || 0);
    if (unite === 'fois') return Math.round(v) + ' fois';
    if (unite === 'distance') {
      // Un dixième de kilomètre est le dernier chiffre qui veuille dire
      // quelque chose ; au-delà de cent, il n'en veut plus dire non plus.
      return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + ' km';
    }
    return formatDuree(v * MS_MINUTE);
  }

  return {
    MS_MINUTE: MS_MINUTE,
    UNITES: UNITES,
    PILIERS: PILIERS,
    EXPOSANT: EXPOSANT,
    coutPourObjectif: coutPourObjectif,
    objectifPourCout: objectifPourCout,
    coutLisible: coutLisible,
    UNITE_DEFAUT: UNITE_DEFAUT,
    BASE_CATEGORIE: BASE_CATEGORIE,
    BASE_GLOBALE: BASE_CATEGORIE,
    reglageDe: reglageDe,
    seuil: seuil,
    niveauPour: niveauPour,
    normaliser: normaliser,
    nettoyer: nettoyer,
    jourDe: jourDe,
    minuit: minuit,
    debutSemaine: debutSemaine,
    parCategorie: parCategorie,
    niveauGlobal: niveauGlobal,
    serie: serie,
    derniersJours: derniersJours,
    agregats: agregats,
    creer: creer,
    supprimer: supprimer,
    formatDuree: formatDuree,
    formatValeur: formatValeur,
    formatEffort: formatEffort
  };
}));
