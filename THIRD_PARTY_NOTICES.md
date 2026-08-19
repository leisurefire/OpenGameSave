# Third-party notices

OpenGameSave is licensed under GPL-3.0-only. Portions of its game-save path
database are derived from the following separately licensed projects:

- [Ludusavi Manifest](https://github.com/mtkennerly/ludusavi-manifest),
  Copyright (c) 2020 Matthew T. Kennerly (mtkennerly), MIT License.
  See `database/licenses/LUDUSAVI-MANIFEST-LICENSE.txt`.
- [XgpSaveTools](https://github.com/brodrigz/XgpSaveTools),
  Copyright (c) 2026 Bruno Rodrigues, MIT License.
  See `database/licenses/XGPSAVETOOLS-LICENSE.txt`.

The complete license texts are distributed with source checkouts and packaged
applications. OpenGameSave uses XgpSaveTools registry mappings, not its
game-specific handlers or executable code.

## Curated guide links

OpenGameSave's guide catalog contains reviewed source names, external URLs, and
short descriptions written for OpenGameSave. It does not bundle, scrape, or
republish the linked articles, images, or game assets.

- [PCGamingWiki](https://www.pcgamingwiki.com/) is linked as an external
  technical reference by the stable page IDs already present in OpenGameSave's
  game database. Its [official redirect API](https://github.com/PCGamingWiki/api)
  is referenced for provenance; OpenGameSave does not copy wiki articles.
- [OverLab / 春语实验室](https://overlab.cn/) is linked as an external Chinese
  Overwatch knowledge base. Its original articles are offered under
  CC BY-NC-SA 4.0; Blizzard-owned content remains Blizzard copyright. See the
  site's [Creative Commons notice](https://overlab.cn/about/creative-commons).
- [Liquipedia Overwatch](https://liquipedia.net/overwatch/Main_Page) is linked
  as an external competitive reference. Liquipedia wiki text is CC BY-SA 3.0;
  images and other media may have separate terms. OpenGameSave does not
  redistribute that content.
- Official Overwatch pages are external links only. Overwatch, Blizzard, and
  related names and content are owned by Blizzard Entertainment and/or their
  respective operators. Their inclusion does not imply endorsement.

## Runtime game artwork

For installed Steam, Epic Games Store, GOG, and Battle.net games, OpenGameSave
first reads artwork from size-limited files in trusted local launcher caches,
manifests, or installation directories. When local artwork is unavailable, it
may retrieve images at runtime through audited official metadata and asset
hosts operated for Valve, Epic Games, GOG, or Blizzard. Remote responses are
checked for an allowlisted HTTPS host, redirect target, image MIME signature,
timeout, and a 12 MiB maximum size before being passed to the renderer.

The renderer does not connect to those remote hosts directly, and its Content
Security Policy permits images only from the application itself and `data:`
URLs. Artwork is not bundled with OpenGameSave and remains the property of the
respective publishers and rights holders. The allowlisted services include
`cdn.akamai.steamstatic.com`, `store-content.ak.epicgames.com`, Epic's
`cdn1.unrealengine.com` and `cdn2.unrealengine.com`, `api.gog.com` and
`images.gog-statics.com`, official `blizzard.com` product pages, and the
specific Blizzard asset CDNs declared in the artwork resolver.
