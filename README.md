# CyclonesTV

Viewer vidéo et outils de gestion du club.

## Démarrer

Installez une version récente de Node.js, puis lancez `npm start` depuis ce dossier. Le serveur écoute sur le port `8080` par défaut. En accès direct, il utilise HTTPS avec un certificat local; derrière Caddy, définissez `BEHIND_CADDY=1`.

Ouvrez `/admin.html` pour gérer le site. Changez le mot de passe administrateur depuis le panneau après la première connexion.

## Gestion des vidéos

Dans **Fichiers vidéo**, l’admin peut envoyer plusieurs vidéos, rechercher et trier le catalogue, sélectionner des fichiers, les déplacer vers un sous-dossier existant, les renommer ou les supprimer. Le déplacement et le renommage mettent aussi à jour les références des onglets et des qualités configurées. Les dossiers de stockage sont sous `videos/`. Les fichiers WebM sont lus directement par le lecteur HTML5 du navigateur si leurs codecs sont pris en charge (VP8/VP9 et Opus sont les plus compatibles).

## Téléchargement YouTube

Le serveur reste compatible avec Node.js 10.19.0 (version utilisée par certains déploiements); il n’est pas nécessaire de remplacer le Node.js partagé par d’autres processus. Le téléchargement YouTube requiert aussi une version récente de `yt-dlp`, `ffmpeg`, `ffprobe`, ainsi que Deno 2+ ou Node.js 20+ pour l’extraction JavaScript. Le panneau admin indique si ces prérequis sont détectés.

Dans le service systemd, rendez Deno visible avec `DENO_PATH=/home/acer/.deno/bin/deno`. La configuration fournie dans `deploy/cpvcyclones.service` contient ce chemin. Pour modifier le service déjà installé sans le remplacer, créez un override avec `sudo systemctl edit cpvcyclones` :

```ini
[Service]
Environment="DENO_PATH=/home/acer/.deno/bin/deno"
Environment="YOUTUBE_COOKIES_PATH=/home/acer/cpvcyclonesviewer/cookies.txt"
```

`YOUTUBE_COOKIES_PATH` doit désigner le fichier exporté depuis Firefox au format Netscape accepté par yt-dlp (`--cookies`). Le fichier doit être lisible uniquement par le compte du service (par exemple `chmod 600` et propriétaire `acer`). Les cookies donnent accès à la session : utilisez si possible un compte dédié, ne les commitez pas, ne les placez pas dans le dossier du site et ne les partagez pas. Après configuration, redémarrez avec `sudo systemctl restart cpvcyclones`. Les cookies expirent parfois et peuvent devoir être réexportés. La configuration ne contourne pas les restrictions de YouTube et seuls les contenus auxquels le compte a accès peuvent être téléchargés.

Pour publier un direct sur l’accueil, cochez **Afficher ce direct à tous les visiteurs de l’accueil** avant de lancer son téléchargement. Le bouton **En direct** apparaît dans le viewer; il intègre le lecteur YouTube officiel pendant que le serveur archive la vidéo. Cette diffusion est publique pour les visiteurs du site et n’est pas le fichier d’archive en cours d’écriture. Un seul direct peut être publié à la fois; l’affichage s’arrête lorsque le téléchargement du direct se termine.

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
