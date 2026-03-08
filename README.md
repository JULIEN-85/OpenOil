# OpenOil

Application web simple pour visualiser des stations-service sur une carte avec:

- disponibilités carburants
- prix par carburant
- comparaison de prix dans un rayon de 10, 20, 30, 40, 50 km
- bonus: alerte prix (stations sous un prix max)
- données live via API `https://api.prix-carburants.2aaz.fr`
- rafraîchissement automatique toutes les 60 secondes

## Lancer le site en local

Tu peux lancer un serveur local au choix.

### Option 1 (Node.js)

```bash
npx serve .
```

### Option 2 (Python)

```bash
python -m http.server 8080
```

Puis ouvre dans ton navigateur:

- http://localhost:3000 (avec `serve`)
- ou http://localhost:8080 (avec `http.server`)

## Données

Source principale:

- API live: `https://api.prix-carburants.2aaz.fr/stations/around/{lat},{lon}`

Source de secours (fallback si indisponibilité API):

- `data/stations.json`

Le site récupère en direct les prix/disponibilités, puis se met à jour automatiquement et via le bouton "Rafraîchir maintenant".
