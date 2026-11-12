# ReAnime PiP Captions

Userscript that keeps ReAnime's live captions in Chrome Picture-in-Picture.

ReAnime paints captions on a canvas over the video. Chrome's PiP window only shows the `<video>`, so the player's PiP button drops them. This script hooks that button and feeds PiP a stream of the current frame with the caption layer already on it. Size, offset, language, and quality follow whatever the player is rendering. (your caption settings will transfer!)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome. (or something like violentmonkey/greasemonkey)
2. Open `reanime-pip-captions.user.js` and confirm the install. (or copy the script contents into a new script)
3. Reload the ReAnime tab, start the episode, and use the player's PiP button.

Matches `reanime.to`, `reanime.cz`, `reanime.wtf`, and the `flixcloud.cc` player.
