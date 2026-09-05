/*
 * Tableau de progression — la face portrait.
 *
 * Une grille de tuiles, une par catégorie. Une tape vaut `+1` ; c'est tout ce
 * que fait cet écran, et c'est délibéré. Le suivi du temps de travail tient
 * parce que la donnée se ramasse toute seule ; celui-ci ne tiendra que si
 * déclarer une séance coûte un geste, pas une saisie.
 *
 * CE FICHIER N'ÉCRIT NI DANS LE STOCKAGE NI SUR LE RÉSEAU. Il demande un état
 * à `SuiviUI`, il lui pose un geste, il se redessine quand on le prévient. Deux
 * fichiers qui écriraient tous deux le journal finiraient par s'écraser l'un
 * l'autre — et le journal est la seule chose qu'on ne peut pas se permettre de
 * perdre.
 */
(function () {
  'use strict';

  var S = window.SuiviTravail;
  var U = window.SuiviUI;
  if (!S || !U) return;

  //: Délai d'annulation d'un `+1`. Assez long pour s'apercevoir de l'erreur et
  //: revenir dessus, assez court pour que le bandeau ne devienne pas un
  //: meuble. Mesuré sur soi : on sait en deux secondes qu'on s'est trompé.
  var ANNULATION_MS = 7000;

  var el = {
    tableau: document.getElementById('tableau'),
    tete: document.getElementById('tab-tete-vue'),
    grille: document.getElementById('tab-grille'),
    annuler: document.getElementById('tab-annuler'),
    annulerTexte: document.getElementById('tab-annuler-texte'),
    annulerBouton: document.getElementById('tab-annuler-bouton'),
    neuve: document.getElementById('tab-neuve'),
    neuveNom: document.getElementById('tab-neuve-nom'),
    neuveCreer: document.getElementById('tab-neuve-creer'),
    neuveUnites: document.getElementById('tab-neuve-unites'),
    neuveFermer: document.getElementById('tab-neuve-fermer'),
    neuveRythme: document.getElementById('tab-neuve-rythme'),
    neuveSuffixe: document.getElementById('tab-neuve-suffixe'),
    neuveResume: document.getElementById('tab-neuve-resume'),
    reglages: document.getElementById('tab-reglages')
  };
  if (!el.tableau) return;

  //: La dernière entrée posée, tant qu'elle est annulable.
  var derniere = null;
  var minuterie = null;

  //: L'unité choisie dans le formulaire de création.
  var uniteNeuve = 'fois';

  function elem(balise, classe, texte) {
    var n = document.createElement(balise);
    if (classe) n.className = classe;
    if (texte !== undefined && texte !== null) n.textContent = texte;
    return n;
  }

  function vider(noeud) {
    while (noeud.firstChild) noeud.removeChild(noeud.firstChild);
  }

  //: Il existe dix blasons ; au-delà, le dernier sert de plafond. C'est le
  //: dessin qui plafonne, jamais la progression.
  var BLASONS = 10;

  function sourceBlason(niveau) {
    var rang = Math.max(1, Math.min(BLASONS, niveau));
    return 'badges/badge-' + (rang < 10 ? '0' : '') + rang + '.png';
  }

  function blason(niveau) {
    var boite = elem('div', 'blason');
    var image = document.createElement('img');
    image.src = sourceBlason(niveau);
    image.alt = 'Niveau ' + niveau;
    boite.appendChild(image);
    return boite;
  }

  /**
   * Repose une image de blason **seulement si elle change**.
   *
   * Réaffecter `src` à la même adresse suffit à faire repasser l'image par le
   * chargement : elle disparaît le temps d'une image, et toute la grille
   * paraît clignoter à chaque `+1`. C'est ce que faisait le rendu complet.
   */
  function majBlason(boite, niveau) {
    var image = boite.firstChild;
    var voulue = sourceBlason(niveau);
    if (image.getAttribute('src') !== voulue) image.setAttribute('src', voulue);
    if (image.alt !== 'Niveau ' + niveau) image.alt = 'Niveau ' + niveau;
  }

  /** N'écrit que si le texte diffère : sinon le navigateur repeint pour rien. */
  function texte(noeud, valeur) {
    if (noeud.textContent !== valeur) noeud.textContent = valeur;
  }

  function jauge(fraction) {
    var j = elem('div', 'jauge tuile-jauge');
    j.appendChild(document.createElement('span'));
    largeurJauge(j, fraction);
    return j;
  }

  /** N'écrit la largeur que si elle change : sinon l'animation CSS rejoue. */
  function largeurJauge(j, fraction) {
    var large = Math.round(100 * Math.max(0, Math.min(1, fraction))) + '%';
    if (j.firstChild.style.width !== large) j.firstChild.style.width = large;
  }

  /**
   * Un appui long sur un élément, sans lui voler ses tapes ordinaires.
   *
   * Le drapeau posé sur le nœud sert à annuler le `click` qui suit : sur un
   * écran tactile, un appui long finit tout de même par en émettre un, et sans
   * lui la correction s'ouvrirait en comptant une séance de plus.
   */
  var APPUI_LONG_MS = 500;

  function brancherAppuiLong(noeud, action) {
    var minuteur = null;
    function arreter() {
      if (minuteur) { clearTimeout(minuteur); minuteur = null; }
    }
    noeud.addEventListener('pointerdown', function () {
      arreter();
      noeud.longAppui = false;
      minuteur = setTimeout(function () {
        minuteur = null;
        noeud.longAppui = true;
        action();
      }, APPUI_LONG_MS);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (nom) {
      noeud.addEventListener(nom, arreter);
    });
  }

  // ── Correction ──────────────────────────────────────────────────────────
  //
  // Le bandeau d'annulation ne défait que le dernier geste ; une erreur
  // s'aperçoit parfois le lendemain, ou après trois autres tapes. L'appui long
  // ouvre donc l'historique de la catégorie, où chaque entrée se retire.

  //: Combien d'entrées montrer. Au-delà, on ne corrige plus, on relit — et ce
  //: n'est pas ce que cet écran sert à faire.
  var ENTREES_MONTREES = 20;

  var elCorr = {
    voile: document.getElementById('voile-corriger'),
    titre: document.getElementById('corr-titre'),
    corps: document.getElementById('corr-corps'),
    fermer: document.getElementById('corr-fermer')
  };

  var categorieCorrigee = null;

  function quandLisible(ms) {
    var d = new Date(ms);
    var jour = new Date(); jour.setHours(0, 0, 0, 0);
    var hier = new Date(jour); hier.setDate(hier.getDate() - 1);
    var heure = ('0' + d.getHours()).slice(-2) + ':' +
                ('0' + d.getMinutes()).slice(-2);
    if (d.getTime() >= jour.getTime()) return 'Aujourd’hui ' + heure;
    if (d.getTime() >= hier.getTime()) return 'Hier ' + heure;
    return ('0' + d.getDate()).slice(-2) + '/' +
           ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + heure;
  }

  function dessinerCorrection() {
    if (!categorieCorrigee) return;
    var c = categorieCorrigee;
    texte(elCorr.titre, c.nom);
    vider(elCorr.corps);

    var liste = U.entrees(c.id, ENTREES_MONTREES);
    if (!liste.length) {
      elCorr.corps.appendChild(elem('p', 'vide',
        'Rien de compté sur cette catégorie pour l’instant.'));
      return;
    }

    var lignes = elem('div', 'lignes');
    liste.forEach(function (e) {
      var ligne = elem('div', 'ligne');
      var tete = elem('div', 'ligne-tete');
      tete.appendChild(elem('span', 'ligne-nom', quandLisible(e.quand)));
      tete.appendChild(elem('span', 'ligne-temps',
                            S.formatValeur(e.valeur, c.unite)));
      var retirer = elem('button', 'retirer', '×');
      retirer.setAttribute('aria-label', 'Retirer cette entrée');
      retirer.addEventListener('click', function () {
        U.retirer(e.id);
        dessinerCorrection();
      });
      tete.appendChild(retirer);
      ligne.appendChild(tete);
      lignes.appendChild(ligne);
    });
    elCorr.corps.appendChild(lignes);

    elCorr.corps.appendChild(elem('p', 'note',
      'Retirer une entrée la marque supprimée sans l’effacer : la suppression ' +
      'doit atteindre les autres appareils, et une ligne absente ne se ' +
      'propage pas.'));
  }

  function ouvrirCorrection(c) {
    categorieCorrigee = c;
    dessinerCorrection();
    elCorr.voile.hidden = false;
  }

  elCorr.fermer.addEventListener('click', function () {
    elCorr.voile.hidden = true;
    categorieCorrigee = null;
    dessiner();
  });

  // ── Annulation ──────────────────────────────────────────────────────────

  function cacherAnnulation() {
    derniere = null;
    if (minuterie) { clearTimeout(minuterie); minuterie = null; }
    el.annuler.hidden = true;
  }

  function offrirAnnulation(idEntree, nom) {
    derniere = idEntree;
    el.annulerTexte.textContent = '+1 · ' + nom;
    el.annuler.hidden = false;
    if (minuterie) clearTimeout(minuterie);
    minuterie = setTimeout(cacherAnnulation, ANNULATION_MS);
  }

  el.annulerBouton.addEventListener('click', function () {
    if (!derniere) return;
    U.retirer(derniere);
    cacherAnnulation();
  });

  // ── Création d'une catégorie ────────────────────────────────────────────

  function dessinerUnitesNeuve() {
    vider(el.neuveUnites);
    (U.unites || []).forEach(function (paire) {
      var bouton = elem('button', 'unite' + (paire[0] === uniteNeuve ? ' active' : ''),
                        paire[1]);
      bouton.type = 'button';
      bouton.addEventListener('click', function () {
        uniteNeuve = paire[0];
        dessinerUnitesNeuve();
        // Le rythme repart au défaut de la nouvelle unité : « 3 » gardé en
        // passant des fois aux kilomètres proposerait trois kilomètres par
        // semaine, ce que personne ne vise.
        poserRythmeNeuve();
      });
      el.neuveUnites.appendChild(bouton);
    });
  }

  /** Remet le rythme au défaut de l'unité choisie, et rafraîchit l'aperçu. */
  function poserRythmeNeuve() {
    var infos = S.UNITES[uniteNeuve] || S.UNITES[S.UNITE_DEFAUT];
    el.neuveRythme.step = String(infos.pas);
    el.neuveRythme.value = String(infos.rythme);
    texte(el.neuveSuffixe, infos.parSemaine);
    apercuRythmeNeuve();
  }

  /** Ce que le rythme saisi coûtera par niveau, dit tout de suite. */
  function apercuRythmeNeuve() {
    var cout = S.coutPourRythme(el.neuveRythme.value, uniteNeuve);
    texte(el.neuveResume,
          cout ? S.coutLisible(cout, uniteNeuve)
               : 'sans rythme visé, le niveau coûte le réglage par défaut');
  }

  function ouvrirNeuve() {
    el.neuve.hidden = false;
    el.neuveNom.value = '';
    uniteNeuve = 'fois';
    dessinerUnitesNeuve();
    poserRythmeNeuve();
    try { el.neuveNom.focus(); } catch (err) { /* sans gravité */ }
  }

  function fermerNeuve() {
    el.neuve.hidden = true;
    el.neuveNom.value = '';
  }

  function creerNeuve() {
    var nom = (el.neuveNom.value || '').trim();
    if (!nom) return;
    U.creerCategorie(nom, uniteNeuve,
                     S.coutPourRythme(el.neuveRythme.value, uniteNeuve));
    fermerNeuve();
    dessiner();
  }

  el.neuveRythme.addEventListener('input', apercuRythmeNeuve);
  el.neuveCreer.addEventListener('click', creerNeuve);
  // Ouvert par mégarde, le formulaire n'avait aucune sortie : il fallait créer
  // une catégorie dont on ne voulait pas pour s'en débarrasser.
  el.neuveFermer.addEventListener('click', fermerNeuve);
  el.neuveNom.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); fermerNeuve(); }
  });
  el.neuveNom.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); creerNeuve(); }
  });

  el.reglages.addEventListener('click', function () { U.ouvrirProgression(); });

  // ── Rendu ───────────────────────────────────────────────────────────────
  //
  // LES TUILES SONT MISES À JOUR, PAS RECONSTRUITES. Le premier rendu les
  // reconstruisait toutes à chaque changement — donc à chaque `+1`, et à chaque
  // synchronisation, soit une fois par minute. Les images de blason repassaient
  // alors par leur chargement, et toute la grille clignotait. Ici chaque tuile
  // garde ses nœuds et n'écrit que ce qui diffère.

  //: Les tuiles vivantes, par identifiant de catégorie.
  var tuiles = {};

  /*
   * GEL APRÈS UN REMANIEMENT DE LA GRILLE.
   *
   * Créer une catégorie fait apparaître sa tuile **exactement là où était le
   * bouton « + Catégorie »** — donc sous le doigt qui vient de s'en servir.
   * Une deuxième tape, ou une tape d'impatience pendant que le formulaire
   * s'ouvrait, comptait aussitôt une séance : la catégorie semblait naître
   * à 1.
   *
   * Le gel ne protège que le comptage. Fermer, corriger, ouvrir les réglages
   * restent possibles : ce qu'on empêche, c'est d'écrire dans le journal par
   * une tape qui visait autre chose.
   */
  var GEL_MS = 700;
  var geleJusqua = 0;

  //: La tuile de création, faite une fois pour toutes.
  var tuileNeuve = null;

  /**
   * Une tuile, et les nœuds qu'elle mettra à jour.
   *
   * Toute sa surface est le bouton — viser un « + » de quelques millimètres
   * d'une main occupée est exactement ce qu'on veut éviter ici.
   */
  function tuile() {
    var bouton = elem('button', 'tuile');
    bouton.type = 'button';

    var parts = {
      blason: blason(1),
      nom: elem('div', 'tuile-nom', ''),
      valeur: elem('div', 'tuile-valeur', ''),
      jauge: jauge(0),
      niveau: elem('span', null, ''),
      jour: elem('span', 'tuile-jour', ''),
      marque: elem('div', 'tuile-marque', 'chrono')
    };
    var pied = elem('div', 'tuile-pied');
    pied.appendChild(parts.niveau);
    pied.appendChild(parts.jour);

    bouton.appendChild(parts.blason);
    bouton.appendChild(parts.nom);
    bouton.appendChild(parts.valeur);
    bouton.appendChild(parts.jauge);
    bouton.appendChild(pied);
    bouton.appendChild(parts.marque);
    bouton.parts = parts;

    // Les écouteurs sont posés UNE FOIS et lisent la catégorie du moment sur le
    // nœud : les reposer à chaque rendu en accumulerait un de plus par tuile et
    // par minute, et un `+1` finirait par en compter plusieurs.
    bouton.addEventListener('click', function () {
      if (bouton.longAppui) { bouton.longAppui = false; return; }
      var c = bouton.categorie;
      if (!c) return;
      // Une catégorie de temps ne se compte pas d'une tape : son historique
      // est ce qu'on vient y chercher. Ouvrir la progression générale, comme
      // au début, répondait à côté de la question posée par le geste.
      if (c.unite === 'temps') { ouvrirCorrection(c); return; }
      // Le gel est posé APRÈS ce qui n'écrit rien. Il existe pour empêcher une
      // tape égarée d'entrer une séance au journal, pas pour rendre la grille
      // inerte — placé plus haut, il bloquait aussi l'ouverture d'un
      // historique, ce que le commentaire qui l'accompagne dément.
      if (Date.now() < geleJusqua) return;
      // Un kilométrage ne se devine pas ; une séance, si. Pour la distance, on
      // demande le nombre — c'est le seul endroit où une saisie est inévitable.
      var valeur = 1;
      if (c.unite === 'distance') {
        var saisi = window.prompt('Combien de kilomètres ?', '');
        valeur = parseFloat(String(saisi || '').replace(',', '.'));
        if (!isFinite(valeur) || valeur <= 0) return;
      }
      var id = U.ajouter(c.id, valeur);
      if (id) offrirAnnulation(id, c.nom);
    });

    // L'appui long ouvre l'historique de la catégorie. C'est le seul moyen de
    // réparer autre chose que la dernière tape : le bandeau d'annulation ne
    // défait qu'un geste, et une erreur s'aperçoit parfois le lendemain.
    brancherAppuiLong(bouton, function () {
      if (bouton.categorie) ouvrirCorrection(bouton.categorie);
    });

    return bouton;
  }

  /** N'écrit sur une tuile que ce qui a changé. */
  function majTuile(bouton, c) {
    bouton.categorie = c;
    var parts = bouton.parts;
    if (bouton.getAttribute('data-categorie') !== c.nom) {
      bouton.setAttribute('data-categorie', c.nom);
    }
    majBlason(parts.blason, c.niveau.niveau);
    texte(parts.nom, c.nom);
    texte(parts.valeur, S.formatValeur(c.valeur, c.unite));
    largeurJauge(parts.jauge, c.niveau.fraction);
    texte(parts.niveau, 'Niv. ' + c.niveau.niveau);
    // Le « + » dit que c'est un ajout du jour et non un total ; rien du tout
    // quand il n'y a rien, car un tiret se lit comme une donnée manquante.
    texte(parts.jour,
          c.aujourdhui > 0 ? '+' + S.formatValeur(c.aujourdhui, c.unite) : '');
    parts.marque.hidden = c.unite !== 'temps';
  }

  function dessinerTete(etat) {
    if (!el.tete.parts) {
      var boite = blason(1);
      var corps = elem('div', 'tab-tete-corps');
      var parts = {
        blason: boite,
        rang: elem('div', 'tab-rang', ''),
        jauge: jauge(0),
        detail: elem('div', 'tab-detail', '')
      };
      corps.appendChild(parts.rang);
      corps.appendChild(parts.jauge);
      corps.appendChild(parts.detail);
      el.tete.appendChild(boite);
      el.tete.appendChild(corps);
      el.tete.parts = parts;
    }
    var p = el.tete.parts;
    majBlason(p.blason, etat.global.niveau);
    texte(p.rang, 'Niveau ' + etat.global.niveau);
    largeurJauge(p.jauge, etat.global.fraction);
    // Les trois piliers sont écrits, et pas seulement le niveau qu'ils donnent :
    // un général qui surprend doit pouvoir être recalculé de tête. Sans eux, il
    // ne peut être ni confirmé ni contesté — c'est ce qui a coûté trois
    // échanges avant qu'on trouve la bonne règle.
    texte(p.detail,
      'Tes 3 meilleures : ' +
      etat.global.retenues.map(function (v) { return Math.floor(v) + 1; }).join(' · ') +
      ' · ' + Math.round(etat.global.fraction * 100) + ' % du niveau ' +
      (etat.global.niveau + 1));
  }

  function dessiner() {
    var etat = U.etat();
    dessinerTete(etat);

    if (!tuileNeuve) {
      tuileNeuve = elem('button', 'tuile tuile-neuve', '+ Catégorie');
      tuileNeuve.type = 'button';
      tuileNeuve.addEventListener('click', ouvrirNeuve);
    }

    var vues = {};
    var precedente = null;
    var bouge = false;
    etat.categories.forEach(function (c) {
      var noeud = tuiles[c.id];
      if (!noeud) { noeud = tuile(); tuiles[c.id] = noeud; }
      majTuile(noeud, c);
      vues[c.id] = true;
      // Replacée seulement si elle n'est pas déjà au bon endroit : déplacer un
      // nœud le retire du document, ce qui suffirait à faire clignoter ce
      // qu'on vient d'éviter de reconstruire.
      var attendue = precedente ? precedente.nextSibling : el.grille.firstChild;
      if (attendue !== noeud) { el.grille.insertBefore(noeud, attendue); bouge = true; }
      precedente = noeud;
    });

    Object.keys(tuiles).forEach(function (id) {
      if (vues[id]) return;
      if (tuiles[id].parentNode) tuiles[id].parentNode.removeChild(tuiles[id]);
      delete tuiles[id];
      bouge = true;
    });

    // Une tuile qui apparaît, disparaît ou change de place déplace toutes les
    // suivantes : ce qui était sous le doigt ne l'est plus.
    if (bouge) geleJusqua = Date.now() + GEL_MS;

    if (el.grille.lastChild !== tuileNeuve) el.grille.appendChild(tuileNeuve);

    if (!el.vide) {
      el.vide = elem('p', 'tab-vide',
        'Aucune catégorie pour l’instant. Ajoutes-en une — muscu, vélo, ' +
        'lecture — et une tape suffira à la compter.');
    }
    if (!etat.categories.length) el.grille.appendChild(el.vide);
    else if (el.vide.parentNode) el.vide.parentNode.removeChild(el.vide);
  }

  // Se redessiner sur tout changement du journal, d'où qu'il vienne : un `+1`
  // posé sur le téléphone doit apparaître ici après la synchro suivante, sans
  // qu'on ait à rouvrir l'application.
  U.abonner(dessiner);

  /*
   * Ne dessiner qu'en portrait, et redessiner à la bascule.
   *
   * La face paysage n'a que faire d'une grille qu'elle ne montre pas ; et le
   * temps écoulé pendant qu'on chronométrait a pu changer la journée, donc les
   * totaux du jour de chaque tuile.
   */
  function enPortrait() {
    return window.matchMedia('(orientation: portrait)').matches;
  }

  function surOrientation() {
    if (enPortrait()) { cacherAnnulation(); dessiner(); }
  }

  window.matchMedia('(orientation: portrait)').addEventListener
    ? window.matchMedia('(orientation: portrait)')
        .addEventListener('change', surOrientation)
    : window.addEventListener('resize', surOrientation);

  if (enPortrait()) dessiner();

  // Exposé pour les tests, qui doivent pouvoir forcer un rendu sans attendre
  // un événement d'orientation que le pilote ne produit pas.
  window.Tableau = { dessiner: dessiner, enPortrait: enPortrait };
})();
