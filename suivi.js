/*
 * Suivi du temps de travail — moteur pur, sans DOM ni réseau.
 *
 * Même parti pris que `timer.js`, et pour les mêmes raisons : tout ce qui se
 * calcule est calculé, rien n'est entretenu en double. Le seul état conservé
 * est le **journal des sessions** ; les totaux, les niveaux et les séries en
 * sont dérivés à chaque lecture. Un compteur « total du jour » rangé à côté
 * finirait par diverger de ses propres données — au premier fuseau franchi, à
 * la première session corrigée, à la première synchro partielle.
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
   * Courbe de niveaux.
   *
   * Le seuil du niveau n vaut `base × (n−1) × n / 2` minutes : chaque niveau
   * demande une tranche un peu plus longue que le précédent. Avec 30 minutes de
   * base, on atteint le niveau 2 après une demi-heure, le 5 après trois heures,
   * le 10 après vingt-deux heures et demie.
   *
   * Une progression linéaire rendrait les premiers niveaux trop lents et les
   * suivants sans relief ; une progression exponentielle rendrait les niveaux
   * élevés inatteignables sur un sujet qu'on travaille deux heures par semaine.
   * Une somme d'entiers tient entre les deux et se calcule de tête.
   */
  var BASE_CATEGORIE = 30;   //: minutes, pour le niveau d'une catégorie
  var BASE_GLOBALE = 60;     //: minutes, pour le niveau général

  /** Minutes cumulées nécessaires pour atteindre `niveau`. Le niveau 1 est à 0. */
  function seuil(niveau, base) {
    if (niveau <= 1) return 0;
    return base * (niveau - 1) * niveau / 2;
  }

  /**
   * Niveau atteint avec `minutes`, et ce qu'il reste avant le suivant.
   *
   * Résolu par recherche montante plutôt que par la formule inverse : la
   * réciproque d'une somme d'entiers passe par une racine carrée, dont
   * l'arrondi flottant fait basculer d'un niveau pile sur les seuils — et les
   * seuils sont exactement les valeurs qu'on regarde.
   */
  function niveauPour(minutes, base) {
    var m = Math.max(0, minutes);
    var niveau = 1;
    while (seuil(niveau + 1, base) <= m) niveau += 1;
    var bas = seuil(niveau, base);
    var haut = seuil(niveau + 1, base);
    var dans = m - bas;
    var largeur = haut - bas;
    return {
      niveau: niveau,
      minutesDansNiveau: dans,
      minutesPourSuivant: haut - m,
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
   * stockage local d'un appareil et une table distante. Une durée absente ou
   * négative, une date illisible, une catégorie vide contamineraient tous les
   * totaux d'un `NaN` sans que rien ne le signale — les agrégats ne lèvent pas,
   * ils affichent.
   */
  function normaliser(brut) {
    if (!brut || typeof brut !== 'object') return null;
    var debut = parseFloat(brut.debut);
    var duree = parseFloat(brut.dureeMs);
    if (!isFinite(debut) || debut <= 0) return null;
    if (!isFinite(duree) || duree <= 0) return null;
    var categorie = typeof brut.categorie === 'string' ? brut.categorie.trim() : '';
    if (!categorie) return null;
    var id = typeof brut.id === 'string' && brut.id ? brut.id : null;
    if (!id) return null;
    return {
      id: id,
      debut: debut,
      dureeMs: duree,
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
  // Toutes les journées sont **locales**. Un suivi de temps de travail se lit
  // dans le fuseau où l'on a travaillé : une session de 23 h 30 appartient à sa
  // soirée, pas au lendemain UTC.

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

  function totalDepuis(entrees, borne) {
    return entrees.reduce(function (somme, e) {
      return e.debut >= borne ? somme + e.dureeMs : somme;
    }, 0);
  }

  /** Millisecondes par catégorie, décroissant. */
  function parCategorie(entrees) {
    var cumul = {};
    entrees.forEach(function (e) {
      cumul[e.categorie] = (cumul[e.categorie] || 0) + e.dureeMs;
    });
    return Object.keys(cumul).map(function (cle) {
      var minutes = cumul[cle] / MS_MINUTE;
      return {
        categorie: cle,
        ms: cumul[cle],
        minutes: minutes,
        niveau: niveauPour(minutes, BASE_CATEGORIE)
      };
    }).sort(function (a, b) { return b.ms - a.ms; });
  }

  /**
   * Jours consécutifs travaillés, en comptant à rebours depuis aujourd'hui.
   *
   * La journée en cours ne rompt pas la série tant qu'elle est vide : à huit
   * heures du matin, personne n'a encore travaillé, et afficher « série
   * interrompue » serait faux autant que décourageant. On repart donc de la
   * veille si aujourd'hui ne compte aucune session.
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

  /** Millisecondes par jour sur les `nombre` derniers jours, du plus ancien. */
  function derniersJours(entrees, maintenant, nombre) {
    var cumul = {};
    entrees.forEach(function (e) {
      var cle = jourDe(e.debut);
      cumul[cle] = (cumul[cle] || 0) + e.dureeMs;
    });
    var sortie = [];
    var d = new Date(minuit(maintenant));
    d.setDate(d.getDate() - (nombre - 1));
    for (var i = 0; i < nombre; i++) {
      var cle = jourDe(d.getTime());
      sortie.push({ jour: cle, ms: cumul[cle] || 0 });
      d.setDate(d.getDate() + 1);
    }
    return sortie;
  }

  /** Tout ce que la vue « progression » a besoin de savoir, en une passe. */
  function agregats(journal, maintenant) {
    var entrees = nettoyer(journal);
    var total = entrees.reduce(function (s, e) { return s + e.dureeMs; }, 0);
    return {
      sessions: entrees.length,
      jour: totalDepuis(entrees, minuit(maintenant)),
      semaine: totalDepuis(entrees, debutSemaine(maintenant)),
      total: total,
      categories: parCategorie(entrees),
      global: niveauPour(total / MS_MINUTE, BASE_GLOBALE),
      serie: serie(entrees, maintenant),
      jours: derniersJours(entrees, maintenant, 7)
    };
  }

  // ── Écriture ────────────────────────────────────────────────────────────

  /**
   * Une nouvelle entrée. `id` est fourni par l'appelant : c'est lui qui sait
   * produire un identifiant unique (`crypto.randomUUID` dans le navigateur), et
   * ce module reste sans dépendance ni source d'aléa — donc rejouable à
   * l'identique dans un test.
   */
  function creer(id, debut, dureeMs, categorie) {
    return normaliser({
      id: id, debut: debut, dureeMs: dureeMs, categorie: categorie,
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

  /** « 3 h 21 », « 45 min », « 0 min ». */
  function formatDuree(ms) {
    var minutes = Math.round(Math.max(0, ms) / MS_MINUTE);
    var heures = Math.floor(minutes / 60);
    var reste = minutes % 60;
    if (!heures) return reste + ' min';
    return heures + ' h' + (reste ? ' ' + pad2(reste) : '');
  }

  return {
    MS_MINUTE: MS_MINUTE,
    BASE_CATEGORIE: BASE_CATEGORIE,
    BASE_GLOBALE: BASE_GLOBALE,
    seuil: seuil,
    niveauPour: niveauPour,
    normaliser: normaliser,
    nettoyer: nettoyer,
    jourDe: jourDe,
    minuit: minuit,
    debutSemaine: debutSemaine,
    parCategorie: parCategorie,
    serie: serie,
    derniersJours: derniersJours,
    agregats: agregats,
    creer: creer,
    supprimer: supprimer,
    formatDuree: formatDuree
  };
}));
