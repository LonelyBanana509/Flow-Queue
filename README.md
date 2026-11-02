# Flow Queue 1.5.1 (video, Ingredients mode)

Queues prompts in Google Flow, sets the aspect ratio, model and count for you, shows each prompt next to its images, and downloads what you keep. Image mode captures. Video (Ingredients) is captured too: each video shows as a card with a thumbnail and is saved as its own file (not in the zip).

## Install
1. Unzip the folder. Open chrome://extensions, turn on Developer mode, click Load unpacked, pick the folder.
2. Open Flow and refresh the tab once. After reloading the extension later, you can just click Start.
3. Update: replace the folder, reload the extension on chrome://extensions, refresh the Flow tab.

Click the toolbar icon on a Flow tab to open the side panel. It is disabled on other tabs.

## Queue tab
1. Paste prompts, one per line. Optional prefix and suffix are added to every prompt (good for a shared style).
2. Wait between prompts: seconds between submissions. Images per prompt: match Flow's x1-x4. Start at prompt #: skip ahead.
3. Start queue. Stop halts after the current step. Resume continues after an interruption without touching results.
4. Test detection checks that the prompt box and generate button are found. Pick them manually if not.

## Flow settings
Tick "Set these in Flow before each prompt" to set the aspect ratio and model from the panel, and Flow's count from "Images per prompt".
Test settings now applies them once and shows what Flow reports. Diagnostics lists the buttons it saw (useful if Flow changes).

Change settings inside the list:
- A line of its own, `[9:16, x4, pro]` or `{9:16}`, applies to every prompt below it until the next settings line.
- `[reset]` goes back to the panel values, or to what Flow was set to when you pressed Start.
- A bracket in front of a prompt, `[1:1] a tall banner`, applies to that prompt only.
- Words: ratios 16:9, 4:3, 1:1, 3:4, 9:16. Counts x1-x4. Models pro, lite, 2.1. Unknown words are ignored.
- Settings lines are not prompts: they are not numbered and get no card.

Safety: the extension checks Flow's chip before each prompt and stops if the settings did not stick (press Resume after fixing). It also stops if a setting would use credits, unless "Allow credit use" is ticked.

## Review tab
- Images appear under the prompt that made them. Each card shows its settings.
- Matching uses the prompt text Flow shows near each image. If that is not available it falls back to submission order and marks the card "check".
- A badge like "1 of 2" flags incomplete prompts.
- Redo / Run: regenerate one prompt. Retry missing: regenerate every incomplete prompt that was submitted.
- Swap...: exchange images with another prompt. Move to...: send one image to another prompt.
- Skip / Keep: leave an image out of downloads. Save: one image. Save set: one prompt's kept images (zip). Download all: every kept image plus prompts.txt.
- Chrome asks once for access to the image host the first time you download.

## Notes
- Starting from prompt 1 replaces the Review tab's results (it asks first). Clear empties the Review tab only.
- Chrome shows a "started debugging this browser" bar while a queue runs. That is how the extension sends trusted clicks and typing.
- If Flow changes its page, use Test detection, Test settings now and the Diagnostics box to see what broke.

## Disclaimer
Flow Queue is an independent project. It is not affiliated with, endorsed by, or sponsored by Google. "Flow", "Veo" and "Nano Banana" are names of Google products and belong to their owners; they are used here only to say what this extension works with.

The extension automates the Flow page in your own browser, using your own signed-in account (it types, clicks and downloads for you). Google's terms may limit automated use of its services, so using it could lead to rate limits or account action. Use it at your own risk and read Flow's terms first. It sends nothing to any server: prompts, settings and results stay in your browser's local extension storage.

## License
MIT. See LICENSE.
