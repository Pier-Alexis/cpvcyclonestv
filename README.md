# CyclonesTV

Viewer vidéo et outils de gestion du club.

## Démarrer

Installez une version récente de Node.js, puis lancez `npm start` depuis ce dossier. Le serveur écoute sur le port `8080` par défaut. En accès direct, il utilise HTTPS avec un certificat local; derrière Caddy, définissez `BEHIND_CADDY=1`.

Ouvrez `/admin.html` pour gérer le site. Changez le mot de passe administrateur depuis le panneau après la première connexion.

## Gestion des vidéos

Dans **Fichiers vidéo**, l’admin peut envoyer plusieurs vidéos, rechercher et trier le catalogue, sélectionner des fichiers, les déplacer vers un sous-dossier existant, les renommer ou les supprimer. Le déplacement et le renommage mettent aussi à jour les références des onglets et des qualités configurées. Les dossiers de stockage sont sous `videos/`.

## Photos

Dans **Photos**, l’admin peut téléverser des images, les prévisualiser, les ajouter aux onglets photo ou les supprimer. La suppression retire aussi la photo des onglets configurés et crée une sauvegarde des données avant de modifier la configuration. Les images sont stockées dans `photos/`. La page `/photos.html` présente toute la bibliothèque avec recherche et aperçu agrandi; les albums configurés restent accessibles depuis les onglets du viewer.

L’export/import JSON existant concerne la configuration du viewer. **Télécharger la sauvegarde des données** exporte en plus les fiches d’athlètes et leurs justificatifs de mot de passe hachés; les fichiers vidéo eux-mêmes ne sont pas inclus.

## Fiches d’athlètes

Dans **Athlètes**, l’admin crée et gère chaque fiche : présentation, catégorie, meilleurs temps et journal d’entraînements. Un mot de passe d’au moins 8 caractères est requis pour créer une fiche; l’admin peut le réinitialiser en saisissant un nouveau mot de passe.

Le bouton **Athlètes** de la page d’accueil permet de se connecter avec le mot de passe personnel, qui doit être différent pour chaque athlète; le panneau admin fournit aussi un lien direct de la forme `/athlete.html?id=<identifiant>`. L’athlète ne peut consulter que sa propre fiche. Dans son profil, il voit son calendrier et peut choisir celui d’un autre athlète. Les événements sans personne ciblée sont ceux du club; l’admin peut en limiter d’autres à des athlètes précis. Les mots de passe sont hachés côté serveur; les sessions sont protégées par cookie `HttpOnly` et expirent après 14 jours.

Les fiches sont enregistrées dans `athletes.json`, créé automatiquement et exclu du dépôt Git. Les sauvegardes automatiques précédant les modifications de configuration et de fiches sont conservées dans `backups/` (20 au maximum). Le serveur empêche leur accès par les URL de fichiers statiques. Gardez aussi les sauvegardes téléchargées dans un emplacement privé.

Pour restaurer une sauvegarde téléchargée, arrêtez le serveur, remplacez `config.json` par la valeur `config` du fichier de sauvegarde et `athletes.json` par sa valeur `athletes`, puis redémarrez le serveur. Faites une copie des fichiers actuels avant toute restauration. Les vidéos doivent être sauvegardées séparément.

## Données personnelles

Les pages d’athlètes peuvent contenir des informations personnelles. Ne partagez chaque lien et mot de passe qu’avec l’athlète concerné, utilisez HTTPS pour tout accès réseau et protégez les exports et les sauvegardes.
