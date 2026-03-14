# OpenOil

Application web simple pour visualiser des stations-service sur une carte avec:

- disponibilités carburants
- prix par carburant
- comparaison de prix dans un rayon de 10, 20, 30, 40, 50 km
- données live via backend local
- rafraîchissement automatique toutes les 60 secondes
- liste des stations affichées triée du moins cher au plus cher

## Lancer le site en local

Installe d'abord les dépendances:

```bash
npm install
```

Puis lance le serveur applicatif:

```bash
npm start
```

Ouvre ensuite dans ton navigateur: http://localhost:8080

## Données

Source principale:

- API officielle Etat: `data.economie.gouv.fr` (dataset flux instantané v2)

Source de secours (fallback si indisponibilité API):

- API `https://api.prix-carburants.2aaz.fr`

Le backend met en cache les données et expose l'endpoint local:

- `GET /api/stations/around?lat={lat}&lon={lon}&radius={km}`

## Deployer sur Vercel (gratuit)

Ce projet est configure pour Vercel avec:

- `api/index.js` comme fonction serverless (Express)
- `vercel.json` pour router `/api/*` vers Express et servir le frontend statique
- Requêtes géofiltrées vers l'API officielle (pas de cache global en mémoire)

### Déploiement automatique via GitHub Actions

Chaque push sur la branche `main` déclenche automatiquement un déploiement sur Vercel grâce au workflow `.github/workflows/deploy.yml`.

**Prérequis — configurer les secrets GitHub du dépôt:**

1. Crée un compte sur [vercel.com](https://vercel.com) (tier gratuit disponible)
2. Installe la CLI Vercel et lie le projet une première fois en local:

```bash
npm i -g vercel
vercel link
```

Cela crée un fichier `.vercel/project.json` contenant `orgId` et `projectId`.

3. Génère un token d'accès personnel sur [vercel.com/account/tokens](https://vercel.com/account/tokens)

4. Dans les paramètres du dépôt GitHub (`Settings > Secrets and variables > Actions`), ajoute les trois secrets suivants:

| Secret | Valeur |
|---|---|
| `VERCEL_TOKEN` | Token généré à l'étape 3 |
| `VERCEL_ORG_ID` | Valeur de `orgId` dans `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | Valeur de `projectId` dans `.vercel/project.json` |

Une fois configuré, chaque push sur `main` déploie automatiquement le site.

### Déploiement manuel (optionnel)

```bash
npm i -g vercel
vercel
vercel --prod
```

L'URL de production Vercel servira:

- le site sur `/`
- l'API sur `/api/stations/around?lat={lat}&lon={lon}&radius={km}`
