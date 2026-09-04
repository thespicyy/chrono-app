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

  function blason(niveau) {
    var boite = elem('div', 'blason');
    var image = document.createElement('img');
    var rang = Math.max(1, Math.min(BLASONS, niveau));
    image.src = 'badges/badge-' + (rang < 10 ? '0' : '') + rang + '.png';
    image.alt = 'Niveau ' + niveau;
    boite.appendChild(image);
    return boite;
  }

  function jauge(fraction) {
    var j = elem('div', 'jauge tuile-jauge');
    var dedans = elem('span');
    dedans.style.width = Math.round(100 * Math.max(0, Math.min(1, fraction))) + '%';
    j.appendChild(dedans);
    return j;
  }

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
      });
      el.neuveUnites.appendChild(bouton);
    });
  }

  function ouvrirNeuve() {
    el.neuve.hidden = false;
    el.neuveNom.value = '';
    uniteNeuve = 'fois';
    dessinerUnitesNeuve();
    try { el.neuveNom.focus(); } catch (err) { /* sans gravité */ }
  }

  function creerNeuve() {
    var nom = (el.neuveNom.value || '').trim();
    if (!nom) return;
    U.creerCategorie(nom, uniteNeuve);
    el.neuve.hidden = true;
    el.neuveNom.value = '';
    dessiner();
  }

  el.neuveCreer.addEventListener('click', creerNeuve);
  el.neuveNom.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); creerNeuve(); }
  });

  el.reglages.addEventListener('click', function () { U.ouvrirProgression(); });

  // ── Rendu ───────────────────────────────────────────────────────────────

  /**
   * Une tuile.
   *
   * Toute sa surface est le bouton — viser un « + » de quelques millimètres
   * d'une main occupée est exactement ce qu'on veut éviter ici.
   */
  function tuile(c) {
    var bouton = elem('button', 'tuile');
    bouton.type = 'button';
    bouton.setAttribute('data-categorie', c.nom);

    bouton.appendChild(blason(c.niveau.niveau));
    bouton.appendChild(elem('div', 'tuile-nom', c.nom));
    bouton.appendChild(elem('div', 'tuile-valeur',
                            S.formatValeur(c.valeur, c.unite)));
    bouton.appendChild(jauge(c.niveau.fraction));

    var pied = elem('div', 'tuile-pied');
    pied.appendChild(elem('span', null, 'Niv. ' + c.niveau.niveau));
    // Ce qui a déjà été compté aujourd'hui : la seule chose qu'on vient
    // vérifier avant de taper, et ce qui évite de compter deux fois.
    pied.appendChild(elem('span', 'tuile-jour',
      c.aujourdhui > 0 ? S.formatValeur(c.aujourdhui, c.unite) : '—'));
    bouton.appendChild(pied);

    if (c.unite === 'temps') {
      // Une catégorie de temps ne se tape pas pour `+1` : la pastille dit
      // pourquoi le geste diffère, au lieu de laisser croire à une panne.
      bouton.appendChild(elem('div', 'tuile-marque', 'chrono'));
      bouton.addEventListener('click', function () {
        U.ouvrirProgression();
      });
      return bouton;
    }

    bouton.addEventListener('click', function () {
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
    return bouton;
  }

  function dessinerTete(etat) {
    vider(el.tete);
    el.tete.appendChild(blason(etat.global.niveau));

    var corps = elem('div', 'tab-tete-corps');
    corps.appendChild(elem('div', 'tab-rang', 'Niveau ' + etat.global.niveau));
    corps.appendChild(jauge(etat.global.fraction));
    corps.appendChild(elem('div', 'tab-detail',
      (etat.serie > 0
        ? etat.serie + (etat.serie > 1 ? ' jours de suite' : ' jour')
        : 'Aucune série en cours') +
      ' · ' + Math.round(etat.global.fraction * 100) + ' % du niveau ' +
      (etat.global.niveau + 1)));
    el.tete.appendChild(corps);
  }

  function dessiner() {
    var etat = U.etat();
    dessinerTete(etat);

    vider(el.grille);
    etat.categories.forEach(function (c) { el.grille.appendChild(tuile(c)); });

    var neuve = elem('button', 'tuile tuile-neuve', '+ Catégorie');
    neuve.type = 'button';
    neuve.addEventListener('click', ouvrirNeuve);
    el.grille.appendChild(neuve);

    if (!etat.categories.length) {
      el.grille.appendChild(elem('p', 'tab-vide',
        'Aucune catégorie pour l’instant. Ajoutes-en une — muscu, vélo, ' +
        'lecture — et une tape suffira à la compter.'));
    }
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
