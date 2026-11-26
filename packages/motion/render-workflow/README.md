# Render repository (template)

This folder holds the files for a SEPARATE small public repository (suggested name `abdusoft-blog-render`) that renders the blog's
video jobs on GitHub-hosted runners. It is deliberately not a workflow of the blog repository: the token the blog API uses to start a
render is scoped to the render repository only, so a leaked token cannot start the blog's own `deploy.yml` (a rollback deploy) or touch its runs.

## What goes into the render repository

| File in this folder | Path in the render repository |
|---|---|
| `render-video.yml` | `.github/workflows/render-video.yml` (on the `main` branch) |
| `README.md` (optional) | `README.md` |

Nothing else is needed: the workflow checks out the blog source itself (`repository: ${{ env.SOURCE_REPO }}`, `ref: main`,
`persist-credentials: false`) and renders from that checkout.

## Settings of the render repository

- **Environment `video-render`** (Settings > Environments), *Deployment branches and tags*: selected branches, `main` only.
  - secret `VIDEO_RUNNER_SECRET`: the same value as `VIDEO_RUNNER_SECRET` in the API environment (`openssl rand -hex 32`);
  - variable `VIDEO_API_ORIGIN`: the public https origin of the API, no trailing slash.
- The blog source repository is hard-coded in the workflow (`SOURCE_REPO`). It decides which code runs with the secret, so it is
  deliberately not a repository variable: change it only with a commit on `main`.
- A fine-grained personal access token limited to THIS repository only, with `Actions: Read and write` (Metadata: Read-only is added
  automatically). Enter it, the repository (`owner/abdusoft-blog-render`) and, if you changed them, the workflow file name and branch in the
  blog settings (Admin > Settings > Video) or in `VIDEO_GITHUB_TOKEN`, `VIDEO_GITHUB_REPO`, `VIDEO_GITHUB_WORKFLOW`, `VIDEO_GITHUB_REF`.

The full operator guide is `docs/video.md` in the blog repository. The workflow is linted with `actionlint` in the blog's CI.
