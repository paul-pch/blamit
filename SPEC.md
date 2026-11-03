# Simple Blame — Spécification

Extension VS Code minimaliste inspirée de GitLens : afficher l'auteur de la ligne courante et ouvrir dans le navigateur le commit ou la MR/PR qui a introduit la ligne.

**Principe directeur : le plus simple possible.** Pas de vue latérale, pas d'historique, pas de graphe, pas de dépendance runtime.

---

## 1. Fonctionnalités

### 1.1 Annotation de la ligne courante
- Quand le curseur est sur une ligne, on affiche un texte grisé en fin de ligne :
  `paul-pch, il y a 3 jours • Fix du parsing des dates`
- Une seule ligne annotée à la fois (celle du curseur principal).
- Lignes non commitées : `Vous • Non commité`.
- Fichier non suivi par git, hors dépôt ou sans commit : pas d'annotation.
- Mise à jour avec un debounce d'environ 150 ms sur les changements de sélection.

### 1.2 Hover
Au survol de l'annotation (ou de la ligne), une infobulle Markdown affiche :
- l'auteur, l'email, la date absolue, le SHA court ;
- le message complet du commit ;
- les liens **Ouvrir le commit** et **Ouvrir la MR/PR**. Le lien MR/PR n'apparaît que si elle a déjà été trouvée. Sinon, le lien « Chercher la MR/PR » lance la commande correspondante.

### 1.3 Commandes
Dans la palette et dans le menu contextuel de l'éditeur (groupe `simpleBlame`), elles s'appliquent toutes à la ligne du curseur :

| Commande | ID |
|---|---|
| Simple Blame: Ouvrir le commit | `simpleBlame.openCommit` |
| Simple Blame: Ouvrir la MR/PR | `simpleBlame.openMergeRequest` |
| Simple Blame: Copier le SHA | `simpleBlame.copySha` |
| Simple Blame: Définir un token API | `simpleBlame.setToken` (palette seulement) |

Si aucune MR/PR n'est trouvée, un message d'information le dit et propose « Ouvrir le commit à la place ».

---

## 2. Hébergeurs supportés

Le type d'hébergeur est déduit de l'URL du remote (`origin` par défaut, sinon le premier remote) :
- l'hôte contient `github` → GitHub ;
- l'hôte contient `gitlab` → GitLab ;
- l'hôte contient `gitea` ou `forgejo` → Gitea ;
- sinon, on consulte le réglage `simpleBlame.hosts`, par exemple `{ "git.maboite.fr": "gitea" }`.

Les remotes SSH (`git@host:group/proj.git`, `ssh://git@host:2222/group/proj.git`) et HTTPS sont normalisés en `https://host/group/proj`. Les sous-groupes GitLab sont gérés.

| | URL du commit | URL de la MR/PR |
|---|---|---|
| GitHub | `/{owner}/{repo}/commit/{sha}` | `/{owner}/{repo}/pull/{n}` |
| GitLab | `/{path}/-/commit/{sha}` | `/{path}/-/merge_requests/{n}` |
| Gitea | `/{owner}/{repo}/commit/{sha}` | `/{owner}/{repo}/pulls/{n}` |

---

## 3. Recherche de la MR/PR

Stratégie : **local d'abord, API en secours si un token est configuré.**

### 3.1 Recherche locale (sans réseau)
1. **Message du commit lui-même** (cas des squash merges) :
   - GitHub : `(#123)` en fin de titre ;
   - GitLab : `See merge request group/proj!123` ;
   - Gitea : `(#123)` en fin de titre.
2. **Commit de merge qui a intégré le commit** : on prend le plus ancien commit présent à la fois dans `git rev-list --ancestry-path --merges <sha>..HEAD` et dans `git rev-list --first-parent --merges <sha>..HEAD`, puis on lit son message :
   - GitHub : `Merge pull request #123 from …` ;
   - GitLab : `See merge request group/proj!123` ;
   - Gitea : `Merge pull request '…' (#123) from …`.

Limite connue : un rebase ou un fast-forward sans référence dans le message laisse la recherche locale sans résultat. L'API prend alors le relais.

### 3.2 API (secours)
Elle n'est utilisée que si un token est défini pour l'hôte :

| | Endpoint |
|---|---|
| GitHub | `GET /repos/{owner}/{repo}/commits/{sha}/pulls` (API `api.github.com` ou `{host}/api/v3` pour GHE) |
| GitLab | `GET /api/v4/projects/{path encodé}/repository/commits/{sha}/merge_requests` |
| Gitea | `GET /api/v1/repos/{owner}/{repo}/commits/{sha}/pull` |

On retient la première MR/PR fusionnée, sinon la première de la liste. Les appels passent par le `fetch` natif de Node, sans dépendance.

### 3.3 Tokens
- Ils sont stockés dans le `SecretStorage` de VS Code, avec une clé par hôte.
- La commande `simpleBlame.setToken` demande l'hôte (pré-rempli avec celui du dépôt courant) puis le token. Une valeur vide supprime le token.

### 3.4 Cache
Résultat par SHA (MR trouvée ou « aucune »), conservé en mémoire pendant la session.

---

## 4. Implémentation

- TypeScript, compilé avec `tsc`, sans bundler ni dépendance runtime.
- Git est appelé via `child_process.execFile('git', …)` dans le dossier du fichier.
- Blame : `git blame --porcelain --contents - -- <fichier>`, avec le contenu du buffer passé sur stdin pour que les numéros de ligne restent justes même quand le fichier est modifié et non sauvegardé.
  - Le résultat est mis en cache par document.
  - Le cache est invalidé à la modification du document, avec un debounce, et à la sauvegarde.
  - Seul le blame du fichier est calculé ; l'annotation lit directement la ligne voulue.
- Affichage : un seul `TextEditorDecorationType` avec `after` (couleur `editorCodeLens.foreground`, italique).
- Hover : un `HoverProvider` qui ne répond que pour la ligne du curseur.

### Arborescence prévue
```
package.json
tsconfig.json
src/
  extension.ts   // activation, commandes, décoration, hover
  git.ts         // blame, remote, recherche de merge commit
  hosts.ts       // détection hébergeur, URLs, parsing messages, appels API
```

### Réglages
| Réglage | Défaut | Rôle |
|---|---|---|
| `simpleBlame.enabled` | `true` | Active ou désactive l'annotation |
| `simpleBlame.remote` | `"origin"` | Remote à utiliser |
| `simpleBlame.hosts` | `{}` | Associe un hôte à un type (`github` / `gitlab` / `gitea`) |

---

## 5. Hors périmètre
Blame du fichier entier, historique de ligne ou de fichier, diff, vues latérales, CodeLens, statut des PR, Bitbucket ou Azure DevOps, multi-curseurs.
