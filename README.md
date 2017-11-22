mfc-node-recorder
=================
Note: This is version has absolutely the same functionality with previous one, however, the code was simplified and cleaned from outdated parts. mfc-node lets you follow and record your favorite models' shows on myfreecams.com

mfc-node
==========
This is an attempt to create a script similar to [capturbate-node](https://github.com/SN4T14/capturebate-node) based on different pieces of code found on the Internet.

Credits:
* [MFCAuto](https://github.com/ZombieAlex/MFCAuto)

Requirements
============
1. [Node.js](https://nodejs.org/download/release/) used to run mfc-node, hence the name. (tested with node v8.1.3)
2. [Livestreamer](https://github.com/chrippa/livestreamer/releases) last version 1.12.2 It's best to be in C:/Livestreamer
3. [Streamlink](https://github.com/streamlink/streamlink) last version 0.9.0 better to install it independently (not in python)
4. [ffmpeg](https://ffmpeg.zeranoe.com/builds/) must be a last version somewere in the path.

Setup
=====
1. Install [Node.js](https://nodejs.org/download/release/) (v8.1.3 or higher).
2. Install [Git](https://git-scm.com/downloads).
2. Download and unpack the [code](https://codeload.github.com/horacio9a/mfc-node/zip/v2).
3. Open console and go into the directory where you unpacked the files.
4. Install requirements by running `npm install` in the same directory as `main.js` is.
5. Edit `config.yml` file and set desirable values for `captureDirectory`, `dateFormat`, `downloadProgram` and `modelScanInterval`

Running
=======
1. Open console and go into the directory where you unpacked the files.
2. Start program with `node main.js`.
3. Open http://localhost:8888 in your browser. 

The list of online models will be displayed with a set of allowed commands for each model:
	Include - if you want to record the model
	Exclude - if you don't want to record the model anymore
	Delete - if you are not interested in the model and wanna hide her permanently

This is not a real-time application. Whenever your `include`, `exclude` or `delete` the model your changes will be applied only with the next iteration of `mainLoop` function of the script. `mainLoop` runs every 30 seconds (default value for `modelScanInterval`).

There is no `auto reload` feature, you have to reload the list manually with `big red button`, however, keep in mind the script updates the list internally every 30 seconds (`modelScanInterval`), therefore sometimes you'll have to wait 30 seconds to see any updates.

Be mindful when capturing many streams at once to have plenty of space on disk and the bandwidth available or you’ll end up dropping a lot of frames and the files will be useless.

The MFC Recorder now captures the MFC streams with three different programs (livestreamer, streamlink and ffmpeg).
Livestreamer and streamlink produce `mp4' files and `ffmpeg` produce `flv` or 'ts' depending on the choice in the `config.yml`.
- Lot of people are asking, so I added the option that every model now has its own subdirectory
- The menu have a small preview, and when the mouse cursor is hover, it will update.
- When you click on a preview thumbnail, you get menu for include, exclude and delete models from list in config.yml.
- By pressing the model 'Name' you get a picture preview of the current model in the room. You can refresh this page later if you are interested in a new situation. If the model is called 'No Mobile Feed' then you will get a link that you can copy and start in a separate browser page and see what's happening in the room. Unfortunately, you can not record this unit with this recorder, but by pressing 'State/Online' you can watch the stream of that model in your browser. 
- By pressing 'State/Online' you can enter in the model room with your browser.
- By pressing the model 'Mob./true' you get a video preview of the current model in separate window of your browser. For this feature in My recommendation is to use the Chrome browser with the installed add-on [Play HLS M3u8](https://chrome.google.com/webstore/detail/play-hls-m3u8/ckblfoghkjhaclegefojbgllenffajdc/related) but if you want firefox then need to install [Native HLS Playback](https://addons.mozilla.org/en-US/firefox/addon/native_hls_playback/)
- If we already have to look at the lines of livestreamer and streamlink I made it to look better and to be useful because we will now know how is big files we are currently recording. 
This can be of help with other downloadings that we do with livestreamer and streamlink.
In your instalation you must found:

... /livestreamer_cli/utils/progress.pyc
or
... /streamlink_cli/utils/progress.py

... and owerwrite existing files with 'progress.py' on this page.

For advanced users
==================
There are several special URLs that allow implementing some operations with a model even if she is offline.

__Include__
```
http://localhost:9080/models/include?nm=modelname
http://localhost:9080/models/include?uid=12345678
```
__Exclude__
```
http://localhost:9080/models/exclude?nm=modelname
http://localhost:9080/models/exclude?uid=12345678
```
__Delete__
```
http://localhost:9080/models/delete?nm=modelname
http://localhost:9080/models/delete?uid=12345678
```
Places that can be clicked

![alt screenshot](./screenshot.jpg)

New look of 'spinner'

![alt screenshot](./screenshot1.jpg)

Look after replacement of 'progress.py'

![alt screenshot](./screenshot2.jpg)

