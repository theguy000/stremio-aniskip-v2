# Stremio AniSkip v2 Plugin

A Stremio Lighting plugin that automatically or manually skips anime openings, endings, and recaps using the AniSkip v2 API.

## Features

- **Automated or Manual Skipping**: Skip openings (`op`), endings (`ed`), and recaps (`recap`) automatically or via an on-screen popup.
- **Metadata Mapping**: Supports resolving anime metadata from IMDb (`tt` IDs) and Kitsu IDs.
- **Visual Seekbar Marks**: Injects timeline indicators directly onto the Stremio player seekbar to show skip segments.
- **Configurable Settings**: Settings menu to toggle Auto-Skip.

## Installation

Download and install the plugin from Stremio Lightning Marketplace.

## Credits

- This project is inspired by [stremio-aniskip](https://github.com/REVENGE977/stremio-aniskip) by [REVENGE977](https://github.com/REVENGE977).
- Skip segment data is provided by the [AniSkip API](https://api.aniskip.com/).
- Anime ID mapping uses [AnimeAPI](https://animeapi.my.id/) for IMDb/Kitsu to MyAnimeList metadata.
- IMDb/Kitsu to MyAnimeList mapping uses [ARM/BQA](https://arm.haglund.dev/docs) by BeeQueue.
- Kitsu metadata is resolved through the [Kitsu API](https://kitsu.docs.apiary.io/) when available.
- Season relation lookup uses [Jikan](https://jikan.moe/) for MyAnimeList relation data.
