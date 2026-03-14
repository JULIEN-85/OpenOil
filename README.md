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

## Deployer sur Vercel

Ce projet est configure pour Vercel avec:

- `api/index.js` comme fonction serverless (Express)
- `vercel.json` pour router `/api/*` vers Express et servir le frontend statique
- Requêtes géofiltrées vers l'API officielle (pas de cache global en mémoire)

Etapes:

```bash
npm i -g vercel
vercel
vercel --prod
```

L'URL de production Vercel servira:

- le site sur `/`
- l'API sur `/api/stations/around?lat={lat}&lon={lon}&radius={km}`
