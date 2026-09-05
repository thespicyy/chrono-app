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
    //: La valeur d'une entrée est en MINUTES ; le rythme, lui, se dit en heures
    //: par semaine — personne ne vise « trois cents minutes ».
    temps: { cout: 600, rythme: 5, parSemaine: 'h / semaine', pas: 0.5 },
    fois: { cout: 20, rythme: 3, parSemaine: 'fois / semaine', pas: 1 },
    distance: { cout: 200, rythme: 50, parSemaine: 'km / semaine', pas: 5 }
  };

  /*
   * QUATRE SEMAINES DE RYTHME TENU VALENT UN NIVEAU.
   *
   * « Combien d'heures vaut un niveau ? » n'a pas de réponse : personne ne
   * raisonne en heures par niveau. « Combien de fois par semaine je vise ? »
   * en a une, immédiate — et le coût s'en déduit.
   *
   * Un mois est le bon pas : assez fréquent pour encourager, assez rare pour
   * vouloir dire quelque chose. Avec dix blasons, il place le dernier à dix
   * mois de régularité — long, mais pas hors d'atteinte.
   */
  var SEMAINES_PAR_NIVEAU = 4;

  /** Le coût d'un niveau, pour un rythme hebdomadaire visé. */
  function coutPourRythme(rythme, unite) {
    var r = Math.max(0, parseFloat(rythme) || 0);
    if (!r) return null;
    // Le temps se vise en heures et se compte en minutes.
    var parUnite = (unite === 'temps') ? 60 : 1;
    return r * parUnite * SEMAINES_PAR_NIVEAU;
  }

  /** Le rythme hebdomadaire qu'implique un coût de niveau. */
  function rythmePourCout(cout, unite) {
    var c = Math.max(0, parseFloat(cout) || 0);
    if (!c) return 0;
    var parUnite = (unite === 'temps') ? 60 : 1;
    return c / parUnite / SEMAINES_PAR_NIVEAU;
  }

  /**
   * Ce que le rythme visé implique, aux deux bouts de l'échelle.
   *
   * Le seul premier palier ne dit plus rien depuis que l'échelle est courbe :
   * il faut le dernier pour comprendre ce qu'on vise. « Niveau 2 à 12 fois,
   * niveau 10 à 972 » se lit d'un coup d'œil, et dit à la fois que le début est
   * proche et que la fin est une distinction.
   */
  function coutLisible(cout, unite) {
    return 'niveau 2 à ' + formatValeur(seuil(2, cout), unite) +
           ' · niveau 10 à ' + formatValeur(seuil(10, cout), unite);
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

  /**
   * Niveau général : l'effort total, mesuré dans la même échelle que chacun.
   *
   * L'unité commune est le **mois de rythme visé** : la valeur d'une catégorie
   * divisée par le coût de son premier niveau. Un mois de muscu et un mois de
   * SQL pèsent alors exactement pareil, quelles que soient leurs unités — et
   * c'est la seule équivalence défendable entre des séances et des heures.
   *
   * ADDITIONNER LES NIVEAUX ÉTAIT FAUX, et se voyait : quatre catégories au
   * niveau 2 — un mois chacune — donnaient un général de 5, autant qu'une
   * pratique de seize mois. Depuis que l'échelle est courbe, deux niveaux de
   * même rang ne coûtent plus la même chose : le cinquième palier vaut neuf
   * mois, le premier en vaut un. Les sommer revenait à les tenir pour égaux, et
   * la largeur se payait au prix de la profondeur.
   *
   * Sur une catégorie unique, le général vaut **exactement** le sien — la même
   * courbe appliquée à la même quantité.
   */
  function niveauGlobal(categories) {
    var mois = categories.reduce(function (somme, c) {
      return somme + (c.cout > 0 ? c.valeur / c.cout : 0);
    }, 0);
    var n = niveauPour(mois, 1);
    return {
      niveau: n.niveau,
      // Le total d'effort, en mois de rythme visé, toutes catégories confondues.
      points: mois,
      mois: mois,
      fraction: n.fraction,
      pourSuivant: n.pourSuivant
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
    SEMAINES_PAR_NIVEAU: SEMAINES_PAR_NIVEAU,
    EXPOSANT: EXPOSANT,
    coutPourRythme: coutPourRythme,
    rythmePourCout: rythmePourCout,
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
    formatValeur: formatValeur
  };
}));
