# Sources de données

Notes techniques issues de l'exploration des sites (septembre 2026). Elles documentent ce que le code de `src/sources/` attend ; si un site change, c'est ici qu'il faut comparer.


## Source 1 : la-spa.fr (API JSON, pas de scraping HTML)
Base : https://www.la-spa.fr/app/wp-json/spa/v1/   (toujours ajouter `?api=1`)
Pas d'authentification pour ces endpoints. 20 requêtes simultanées → 200 OK, ~2s chacune.

### GET /animals/search/?api=1&species=chat&seed=<int>&posts_per_page=500&paged=N
Params (découverts dans le bundle React) : city, latitude, longitude, establishment (slugs séparés par virgule),
name, species (chat|chien|nac|...), race, sex (male|female), criteria (fad,sos,expert), age (junior|adult|senior),
paged, posts_per_page (500 OK), seed (IMPORTANT : ordre aléatoire seedé — garder un seed fixe pour paginer
sans doublons ; vérifié : 5 pages × 500 = 2406 IDs uniques), full=1 (aucun effet visible), post_id, filters=0.
- latitude/longitude : le serveur ne renvoie que les animaux des refuges à ~100 km (rayon fixe, non paramétrable ;
  Paris → 8 refuges de 10 à 88 km, refuge à 121 km exclu). `city` seul ne filtre rien (le front géocode via
  api-adresse.data.gouv.fr puis envoie latitude/longitude).
- Réponse : { total, nb_pages, results: [...], filters: [...], default_filters: [...], animals_criterias }
- Item results :
  { ID, name ("PERLE ( réservée )" → mot "réservé" dans le nom = réservé), url "/animal/slug/", uid "animal-slug",
    full_url, image, imageWebp, sex "male|female", sex_label, color, species "chat", species_label, races_label,
    age "junior|adult|senior", age_label, age_number ("3 ans" | "1 an" | "N/A"), 
    establishment { ID, name, slug, url, search_url }, fad, expr, sos, created_at "YYYY-MM-DD HH:MM:SS" (heure Paris) }
- age_number vaut "N/A" pour TOUS les chats de moins d'1 an (686 junior N/A sur 1340 junior) → il faut la fiche
  détaillée pour la date de naissance. Les adultes "N/A" (117) ont birthday=null (inconnue).
- Statistiques (24/09/2026) : 2406 chats ; junior=1340 ; près de Paris : 324 chats, 164 junior dont 64 N/A.
- created_at max = aujourd'hui → données vivantes ; created_at = date de mise en ligne ("nouvel arrivant").

### GET /posts/?api=1&_uid=animal-<slug>   (fiche détaillée)
Réponse : { metas, post_id, seo_link, breadcrumb, content: { infos, establishment, animaux, ... } }
content.infos : { ID, title, argos_id, fad, expr, sos, species {name}, races [{name}], 
  birthday "Né(e) le 2026-07-01" (ou null), age, sex "Mâle|Femelle", colors [], accepted {dog,cat,child},
  description (html|null), behaviors [], medias [{type,src,webp}] }
content.establishment.map[0] : { ID, name, address "rue<br>CP Ville", latitude, longitude }
(/animals-single/<slug> ne renvoie que {exists:true} ; /pages/?_uid=animal-x → "Ce contenu n'est pas une page")

### GET /establishments/?api=1
{ items: [ { ID, name, address "…<br>92230 Gennevilliers", latitude "48.94", longitude "2.30", url "/etablissement/<slug>/",
  filter {ID,name: "Refuges|Maisons SPA|Fourrières|Dispensaires|Clubs jeunes|Siège"} , phone, email, opening_hours, image } ] }
147 items, tous avec lat/lng et code postal dans address. Slug = dernier segment de url = establishment.slug des résultats.

### GET /animals/count/?api=1 → {count}

## Source 2 : secondechance.org (HTML serveur, scraping léger)
- Recherche : GET https://www.secondechance.org/animal/recherche?species=2&department=<id>&ageRanges[0]=1&page=N
  species=2 → Chat. ageRanges : 1=Bébé, 2=Junior, 3=Adulte, 4=Senior. Autres : region=<id> (2 = Île-de-France),
  adoptableOutsideDepartment=1 (élargit aux assos acceptant l'adoption hors département), sexes[]=1|2, name, breed.
- department=<id interne> ≠ numéro de département ! Mapping via <select id="department"> : `<option value="41">75 - Paris`
  (104 options ; extrait dans data/secondechance_departements.json).
- 12 résultats/page ; "<N> résultats trouvés" ; pagination `&page=2` ; ordre = ID décroissant (plus récent d'abord).
- Cartes (dans la zone après "N résultats trouvés" et AVANT `<!-- Coup de coeur -->` / `<h2>Coup de coeur`) :
  <a href="https://www.secondechance.org/animal/chat-europeen-sweety-1519459"> … <h3>Sweety</h3>
  <h4>AFELP (95)</h4> <p class="open-sans text-sm …">EUROPÉEN Mâle - 6 mois</p>
  → id = dernier nombre de l'URL ; asso + (département) ; race / sexe / âge ("2 mois", "3 ans", peut manquer).
  Une carte "Coup de coeur" (autre espèce possible, ex. GERBILLE) suit les résultats : à exclure.
- Fiche : GET https://www.secondechance.org/animal/<slug>-<id>
  - attributs sur un div : espece="Chat" type="EUROPÉEN" sexe="Mâle" couleur="…" pelage="Ras" age="6 mois" taille="Moyen" update="24/09/2026"
  - texte : "Date de naissance : 01/03/2026" ; section "Présentation" = description.
  - JSON-LD de l'association : "url": ".../refuge/val-d-oise/afelp-1304", "address": { "postalCode": "95300", "addressLocality": "Pontoise", "addressRegion": "Île-de-France" }
  - lien asso : href="https://www.secondechance.org/refuge/val-d-oise/afelp-1304"

## Géocodage
- api-adresse.data.gouv.fr/search/?q=75011&limit=1 → OK une fois, puis "connection reset" depuis le bac à sable (relais).
  À utiliser en option avec repli sur le centroïde du département (table locale data/departements.json).

## Non retenu
- leboncoin.fr / api.leboncoin.fr → 403 (DataDome) ; adopteunchat.fr → connexion coupée.
