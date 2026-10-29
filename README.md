# CyclonesTV

Viewer vidéo et outils de gestion du club.

## Démarrer

Installez une version récente de Node.js, puis lancez `npm start` depuis ce dossier. Le serveur écoute sur le port `8080` par défaut. En accès direct, il utilise HTTPS avec un certificat local; derrière Caddy, définissez `BEHIND_CADDY=1`.

Ouvrez `/admin.html` pour gérer le site. Changez le mot de passe administrateur depuis le panneau après la première connexion.

## Gestion des vidéos

Dans **Fichiers vidéo**, l’admin peut envoyer plusieurs vidéos, rechercher et trier le catalogue, sélectionner des fichiers, les déplacer vers un sous-dossier existant, les renommer ou les supprimer. Le déplacement et le renommage mettent aussi à jour les références des onglets et des qualités configurées. Les dossiers de stockage sont sous `videos/`.

## Téléchargement YouTube

Le téléchargement YouTube requiert une version récente de `yt-dlp`, `ffmpeg`, `ffprobe`, ainsi que Deno 2+ ou Node.js 20+ pour l’extraction JavaScript. Le panneau admin indique si ces prérequis sont détectés. Installez les outils dans le `PATH` du compte qui exécute le service; redémarrez le service après leur installation ou leur mise à jour.

Certaines vidéos exigent une session YouTube. Dans ce cas, exportez les cookies d’un compte autorisé vers un fichier Netscape sur le serveur, hors du dossier du site, puis configurez le service avec `YOUTUBE_COOKIES_PATH` pointant vers ce fichier. Pour systemd, créez un override avec `sudo systemctl edit cpvcyclones` :

```ini
[Service]
Environment="YOUTUBE_COOKIES_PATH=/home/acer/private/youtube-cookies.txt"
```

Le fichier doit être lisible uniquement par le compte du service (par exemple `chmod 600` et propriétaire `acer`). Les cookies donnent accès à la session : utilisez si possible un compte dédié, ne les commitez pas, ne les placez pas dans le dossier du site et ne les partagez pas. Après configuration, redémarrez avec `sudo systemctl restart cpvcyclones`. Les cookies expirent parfois et peuvent devoir être réexportés. La configuration ne contourne pas les restrictions de YouTube et seuls les contenus auxquels le compte a accès peuvent être téléchargés.

## Photos

Dans **Photos**, l’admin peut créer des dossiers et sous-dossiers, y téléverser ou déplacer des images, les prévisualiser, les ajouter aux onglets photo ou les supprimer. Un déplacement met à jour les références des onglets configurés; la suppression les retire également. Une sauvegarde des données est créée avant ces modifications de configuration. Les images sont stockées dans `photos/`. La page `/photos.html` permet de parcourir les dossiers et présente les images avec recherche et aperçu agrandi; les albums configurés restent accessibles depuis les onglets du viewer.

L’export/import JSON existant concerne la configuration du viewer. **Télécharger la sauvegarde des données** exporte en plus les fiches d’athlètes et leurs justificatifs de mot de passe hachés; les fichiers vidéo eux-mêmes ne sont pas inclus.

## Fiches d’athlètes

Dans **Athlètes**, l’admin crée et gère chaque fiche : présentation, catégorie, meilleurs temps et journal d’entraînements. Un mot de passe d’au moins 8 caractères est requis pour créer une fiche; l’admin peut le réinitialiser en saisissant un nouveau mot de passe.

Le bouton **Athlètes** de la page d’accueil permet de se connecter avec le mot de passe personnel, qui doit être différent pour chaque athlète; le panneau admin fournit aussi un lien direct de la forme `/athlete.html?id=<identifiant>`. L’athlète ne peut consulter que sa propre fiche. Dans son profil, il voit son calendrier et peut choisir celui d’un autre athlète. Les événements sans personne ciblée sont ceux du club; l’admin peut en limiter d’autres à des athlètes précis. Les mots de passe sont hachés côté serveur; les sessions sont protégées par cookie `HttpOnly` et expirent après 14 jours.

Les fiches sont enregistrées dans `athletes.json`, créé automatiquement et exclu du dépôt Git. Les sauvegardes automatiques précédant les modifications de configuration et de fiches sont conservées dans `backups/` (20 au maximum). Le serveur empêche leur accès par les URL de fichiers statiques. Gardez aussi les sauvegardes téléchargées dans un emplacement privé.

Pour restaurer une sauvegarde téléchargée, arrêtez le serveur, remplacez `config.json` par la valeur `config` du fichier de sauvegarde et `athletes.json` par sa valeur `athletes`, puis redémarrez le serveur. Faites une copie des fichiers actuels avant toute restauration. Les vidéos doivent être sauvegardées séparément.

## Données personnelles

Les pages d’athlètes peuvent contenir des informations personnelles. Ne partagez chaque lien et mot de passe qu’avec l’athlète concerné, utilisez HTTPS pour tout accès réseau et protégez les exports et les sauvegardes.
