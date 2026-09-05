/*
 * Tableau de progression — la face portrait.
 *
 * C'EST LA PAGE DE PROGRESSION, RENDUE VIVANTE : le blason en grand, le niveau,
 * la semaine, puis une ligne par catégorie — et chaque ligne se tape pour
 * compter `+1`. Un seul écran, parce qu'il n'y a qu'une seule chose à y voir.
 *
 * Le suivi du temps de travail tient parce que la donnée se ramasse toute
 * seule ; celui-ci ne tiendra que si déclarer une séance coûte un geste, pas
 * une saisie.
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

    corps: document.getElementById('tab-corps'),
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
    reglages: document.getElementById('tab-reglages'),
    fermer: document.getElementById('tab-fermer')
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

  function blason(niveau, taille) {
    var boite = elem('div', 'blason' + (taille ? ' blason-' + taille : ''));
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
    var j = elem('div', 'jauge');
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
        // L'objectif repart au défaut de la nouvelle unité : « 1000 » gardé en
        // passant des fois aux heures fixerait la maîtrise à mille heures, ce
        // que personne ne vise.
        poserObjectifNeuf();
      });
      el.neuveUnites.appendChild(bouton);
    });
  }

  /** Remet l'objectif au défaut de l'unité choisie, et rafraîchit l'aperçu. */
  function poserObjectifNeuf() {
    var infos = S.UNITES[uniteNeuve] || S.UNITES[S.UNITE_DEFAUT];
    el.neuveRythme.step = String(infos.pas);
    el.neuveRythme.value = String(infos.objectif);
    texte(el.neuveSuffixe, infos.suffixe);
    apercuObjectifNeuf();
  }

  /** Les premières marches qu'implique l'objectif saisi, dites tout de suite. */
  function apercuObjectifNeuf() {
    var cout = S.coutPourObjectif(el.neuveRythme.value, uniteNeuve);
    texte(el.neuveResume,
          cout ? S.coutLisible(cout, uniteNeuve)
               : 'sans objectif, les paliers gardent le réglage par défaut');
  }

  function ouvrirNeuve() {
    el.neuve.hidden = false;
    el.neuveNom.value = '';
    uniteNeuve = 'fois';
    dessinerUnitesNeuve();
    poserObjectifNeuf();
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
                     S.coutPourObjectif(el.neuveRythme.value, uniteNeuve));
    fermerNeuve();
    dessiner();
  }

  el.neuveRythme.addEventListener('input', apercuObjectifNeuf);
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

  // Ouvre les CATÉGORIES, pas la progression : celle-ci est déjà la page qu'on
  // a sous les yeux, et la rouvrir par-dessus donnait deux fois le même écran.
  el.reglages.addEventListener('click', function () { U.ouvrirCategories(); });

  // ── Surcouche, pour la face paysage ─────────────────────────────────────
  //
  // En portrait, cette page EST l'application : elle n'a rien à ouvrir ni à
  // fermer. En paysage, on la pose au-dessus de l'horloge le temps de la
  // consulter — même page, même code, autre hôte.

  function ouvrirSurcouche() {
    dessiner();
    el.tableau.classList.add('ouvert');
  }

  function fermerSurcouche() {
    el.tableau.classList.remove('ouvert');
  }

  el.fermer.addEventListener('click', fermerSurcouche);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && el.tableau.classList.contains('ouvert')) {
      fermerSurcouche();
    }
  });

  // ── Rendu ───────────────────────────────────────────────────────────────
  //
  // LA FACE PORTRAIT EST LA PAGE DE PROGRESSION, RENDUE VIVANTE. Elle a
  // d'abord été une grille de tuiles à côté d'un panneau de statistiques : deux
  // écrans pour une seule chose, et celui qu'on voulait voir en arrivant —
  // le blason en grand, le niveau, la semaine — n'était pas celui qui
  // s'ouvrait. Il n'en reste qu'un, où chaque ligne se tape.
  //
  // LES LIGNES SONT MISES À JOUR, PAS RECONSTRUITES. Reconstruire les images de
  // blason les fait repasser par leur chargement, et toute la liste clignote à
  // chaque `+1` — et à chaque synchronisation, soit une fois par minute.

  //: Les lignes vivantes, par identifiant de catégorie.
  var lignes = {};

  //: La ligne de création, faite une fois pour toutes.
  var ligneNeuve = null;

  /*
   * GEL APRÈS UN REMANIEMENT DE LA LISTE.
   *
   * Une ligne qui apparaît, disparaît ou change de rang déplace toutes les
   * suivantes : ce qui était sous le doigt ne l'est plus. Créer une catégorie
   * faisait ainsi naître sa ligne là où le doigt venait de se poser, et une
   * seconde tape y comptait aussitôt une séance.
   *
   * Le gel ne protège que le comptage. Ouvrir un historique, les réglages ou
   * le formulaire reste possible : ce qu'on empêche, c'est d'écrire au journal
   * par une tape qui visait autre chose.
   */
  var GEL_MS = 700;
  var geleJusqua = 0;

  /**
   * Une ligne de catégorie : blason, nom, valeur, jauge, niveau.
   *
   * C'est un bouton sur toute sa largeur — viser une cible de quelques
   * millimètres d'une main occupée est exactement ce qu'on veut éviter.
   */
  function ligne() {
    var bouton = elem('button', 'ligne ligne-blason ligne-bouton');
    bouton.type = 'button';

    var parts = {
      blason: blason(1),
      nom: elem('span', 'ligne-nom', ''),
      valeur: elem('span', 'ligne-temps', ''),
      jauge: jauge(0),
      pied: elem('div', 'ligne-pied', ''),
      jour: elem('span', 'ligne-jour', '')
    };

    var tete = elem('div', 'ligne-tete');
    tete.appendChild(parts.nom);
    tete.appendChild(parts.valeur);

    var corps = elem('div', 'ligne-corps');
    corps.appendChild(tete);
    corps.appendChild(parts.jauge);
    var bas = elem('div', 'ligne-bas');
    bas.appendChild(parts.pied);
    bas.appendChild(parts.jour);
    corps.appendChild(bas);

    bouton.appendChild(parts.blason);
    bouton.appendChild(corps);
    bouton.parts = parts;

    // Les écouteurs sont posés UNE FOIS et lisent la catégorie du moment sur le
    // nœud : les reposer à chaque rendu en accumulerait un de plus par ligne et
    // par minute, et un `+1` finirait par en compter plusieurs.
    bouton.addEventListener('click', function () {
      if (bouton.longAppui) { bouton.longAppui = false; return; }
      var c = bouton.categorie;
      if (!c) return;
      // Une catégorie de temps ne se compte pas d'une tape : son historique est
      // ce qu'on vient y chercher.
      if (c.unite === 'temps') { ouvrirCorrection(c); return; }
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

    brancherAppuiLong(bouton, function () {
      if (bouton.categorie) ouvrirCorrection(bouton.categorie);
    });

    return bouton;
  }

  /** N'écrit sur une ligne que ce qui a changé. */
  function majLigne(bouton, c) {
    bouton.categorie = c;
    var parts = bouton.parts;
    if (bouton.getAttribute('data-categorie') !== c.nom) {
      bouton.setAttribute('data-categorie', c.nom);
    }
    majBlason(parts.blason, c.niveau.niveau);
    texte(parts.nom, c.nom);
    texte(parts.valeur, S.formatValeur(c.valeur, c.unite));
    largeurJauge(parts.jauge, c.niveau.fraction);
    // « Niveau 2 · reste 28 h 20 » plutôt que « … avant le 3 » : sur une
    // colonne de téléphone, la forme longue passait à la ligne pour deux mots.
    texte(parts.pied,
          'Niveau ' + c.niveau.niveau + ' · reste ' +
          S.formatValeur(c.niveau.pourSuivant, c.unite));
    // Le « + » dit que c'est un ajout du jour et non un total ; rien du tout
    // quand il n'y a rien, car un tiret se lit comme une donnée manquante.
    texte(parts.jour,
          c.aujourdhui > 0 ? '+' + S.formatValeur(c.aujourdhui, c.unite) : '');
  }

  /**
   * Le niveau général : le blason en grand, le reste à côté.
   *
   * IL EST DANS LE CORPS, PAS DANS L'EN-TÊTE. Logé là-haut, il était contraint
   * à la hauteur d'une barre de titre — et ce qu'on vient voir en ouvrant la
   * page devenait une ligne d'état. C'est le blason en grand qui donne envie
   * d'y revenir ; le reste l'accompagne.
   *
   * Le nœud est **persistant** : reconstruit à chaque rendu, son image
   * repasserait par le chargement et clignoterait à chaque `+1`.
   */
  function dessinerGeneral(etat) {
    if (!el.general) {
      var boite = blason(1, 'grand');
      var cote = elem('div', 'general-cote');
      var parts = {
        blason: boite,
        rang: elem('div', 'general-rang', ''),
        jauge: jauge(0),
        reste: elem('div', 'general-reste', '')
      };
      cote.appendChild(parts.rang);
      cote.appendChild(parts.jauge);
      cote.appendChild(parts.reste);

      el.general = elem('div', 'general');
      el.general.appendChild(boite);
      el.general.appendChild(cote);
      el.general.parts = parts;
    }
    var p = el.general.parts;
    majBlason(p.blason, etat.global.niveau);
    texte(p.rang, 'Niveau ' + etat.global.niveau);
    largeurJauge(p.jauge, etat.global.fraction);
    // Les trois piliers sont écrits, et pas seulement le niveau qu'ils donnent :
    // un général qui surprend doit pouvoir être recalculé de tête. Sans eux, il
    // ne peut être ni confirmé ni contesté.
    texte(p.reste,
      'Tes ' + etat.global.piliers + ' meilleures : ' +
      etat.global.retenues.map(function (v) { return Math.floor(v) + 1; }).join(' · ') +
      ' · ' + Math.round(etat.global.fraction * 100) + ' % du niveau ' +
      (etat.global.niveau + 1));
    if (el.corps.firstChild !== el.general) {
      el.corps.insertBefore(el.general, el.corps.firstChild);
    }
  }

  /** Les trois totaux : aujourd'hui, la semaine, la série. */
  function dessinerTotaux(etat) {
    var totaux = elem('div', 'totaux');
    [['Aujourd’hui', S.formatDuree(etat.jour * S.MS_MINUTE)],
     ['Cette semaine', S.formatDuree(etat.semaine * S.MS_MINUTE)],
     ['Série', etat.serie + (etat.serie > 1 ? ' jours' : ' jour')]
    ].forEach(function (paire) {
      var carte = elem('div', 'total');
      carte.appendChild(elem('div', 'total-valeur', paire[1]));
      carte.appendChild(elem('div', 'total-nom', paire[0]));
      totaux.appendChild(carte);
    });
    return totaux;
  }

  /** Les sept derniers jours, en heures chronométrées. */
  function dessinerSemaine(etat) {
    var maxi = etat.jours.reduce(function (m, j) { return Math.max(m, j.ms); }, 0);
    var semaine = elem('div', 'semaine');
    var LETTRES = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
    etat.jours.forEach(function (j) {
      var colonne = elem('div', 'barre-jour' + (j.ms > 0 ? ' travaille' : ''));
      colonne.appendChild(elem('b', null, j.ms > 0 ? compact(j.ms) : '·'));
      var fut = elem('div', 'fut');
      var barre = elem('i');
      barre.style.height =
        (maxi > 0 ? Math.max(3, Math.round(100 * j.ms / maxi)) : 3) + '%';
      fut.appendChild(barre);
      colonne.appendChild(fut);
      var d = new Date(j.jour + 'T12:00:00');
      colonne.appendChild(elem('u', null, LETTRES[(d.getDay() + 6) % 7]));
      semaine.appendChild(colonne);
    });
    return semaine;
  }

  /** « 3h21 », « 45m » — la forme longue ne tient pas sous une colonne. */
  function compact(ms) {
    var minutes = Math.round(ms / S.MS_MINUTE);
    var heures = Math.floor(minutes / 60);
    var reste = minutes % 60;
    if (!heures) return minutes + 'm';
    if (!reste) return heures + 'h';
    return heures + 'h' + (reste < 10 ? '0' : '') + reste;
  }

  function dessiner() {
    var etat = U.etat();
    dessinerGeneral(etat);

    if (!ligneNeuve) {
      ligneNeuve = elem('button', 'ligne ligne-bouton ligne-neuve', '+ Catégorie');
      ligneNeuve.type = 'button';
      ligneNeuve.addEventListener('click', ouvrirNeuve);
    }

    // Les deux blocs du haut n'ont ni image ni écouteur : les refaire ne coûte
    // rien et évite de tenir un état de plus.
    // Retiré par son parent réel, et non par celui qu'on suppose : le nœud peut
    // avoir été détaché entre deux rendus, et `removeChild` lève dans ce cas —
    // ce qui interromprait le rendu au premier tiers.
    if (el.resume && el.resume.parentNode) {
      el.resume.parentNode.removeChild(el.resume);
    }
    el.resume = elem('div', 'tab-resume');
    if (etat.sessions) {
      el.resume.appendChild(dessinerTotaux(etat));
      el.resume.appendChild(dessinerSemaine(etat));
    }
    el.corps.insertBefore(el.resume, el.general.nextSibling);

    var vues = {};
    var precedente = el.resume;
    var bouge = false;
    etat.categories.forEach(function (c) {
      var noeud = lignes[c.id];
      if (!noeud) { noeud = ligne(); lignes[c.id] = noeud; bouge = true; }
      majLigne(noeud, c);
      vues[c.id] = true;
      // Replacée seulement si elle n'est pas déjà au bon endroit : déplacer un
      // nœud le retire du document, ce qui suffirait à faire clignoter ce qu'on
      // vient d'éviter de reconstruire.
      var attendue = precedente.nextSibling;
      if (attendue !== noeud) { el.corps.insertBefore(noeud, attendue); bouge = true; }
      precedente = noeud;
    });

    Object.keys(lignes).forEach(function (id) {
      if (vues[id]) return;
      if (lignes[id].parentNode) lignes[id].parentNode.removeChild(lignes[id]);
      delete lignes[id];
      bouge = true;
    });

    if (el.corps.lastChild !== ligneNeuve) el.corps.appendChild(ligneNeuve);
    if (bouge) geleJusqua = Date.now() + GEL_MS;
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
   * totaux du jour de chaque ligne.
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
  window.Tableau = {
    dessiner: dessiner,
    enPortrait: enPortrait,
    ouvrir: ouvrirSurcouche,
    fermer: fermerSurcouche,
    ouvert: function () { return el.tableau.classList.contains('ouvert'); }
  };
})();
