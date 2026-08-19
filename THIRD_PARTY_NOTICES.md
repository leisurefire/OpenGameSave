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

For installed Steam games whose artwork is not already available in the local
Steam library cache, OpenGameSave may fetch store artwork at runtime from the
allowlisted `cdn.akamai.steamstatic.com` host. These images are not bundled
with OpenGameSave. Steam, the Steam logo, and store artwork remain the property
of Valve and/or the relevant game publishers and are used only to identify the
user's installed games.

For the supported Battle.net Overwatch entry, OpenGameSave may display an
official Overwatch image at runtime from the allowlisted
`ld5.res.netease.com` host. The image is not bundled. Overwatch artwork and
related marks remain the property of Blizzard Entertainment and/or NetEase.
