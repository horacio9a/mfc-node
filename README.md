What's new?
==========
Version 4.0.0 came out after a slightly longer break. During that time, a lot has changed, so this program had to be adapted to the new situation. 
It seems that MFC rejected rtmp, so there are no more models that we could not record with this program. 
I kept the division into HD and SD models, and there is no need for LD anymore, because there are no more models with CS less than 840 that were exclusively rtmp. 
Don’t take the division into HD and SD literally as far as video quality itself is concerned, as there are frequent exceptions from both categories. 
Recording to text files has also been added for SD links in addition to existing HD links. It is now possible to preview snapshots and videos for all models. 
Basically everything that didn't work before works great now. If the recording doesn’t work it most likely means the model has meanwhile gone Private, Away or Offline. 
It is best to use the Streamlink program. Youtube-dl also records well, but it seems that the interruption of video recording must be resolved (it doesn't work for me). 
Ffmpeg as before has a freeze during video recording but there is always hope that someone will fix it in the future versions.
It is still possible the option of selecting 4 combinations of subdirectory names. More is explained in the `config.yml` file.
It is still possible the option of 'queue' so you can add the model you are looking for at the end of `config.yml` like this:

queue: [nm: TheIconicGirl,nm: LovelyClara4u,uid: 34519531]

Now we have only this three programs for recording live MFC models videos:

1. streamlink - mp4 - sl
2. ffmpeg     - flv - ff
3. youtube-dl - ts  - yt

mfc-node
========
mfc-node lets you follow and record your favorite models' shows on myfreecams.com
This is based on script similar to [capturbate-node] founded on the Github.

Credits:
* [capturbate-node](https://github.com/SN4T14/capturebate-node)
* [mfc-node](https://github.com/sstativa/mfc-node)
* [MFCAuto](https://github.com/ZombieAlex/MFCAuto)

Requirements
============
1. [Node.js](https://nodejs.org/download/release/) used to run mfc-node, hence the name. (tested with node v14.15.4-x64)
2. [Streamlink](https://github.com/streamlink/streamlink/releases) (tested with the last version 2.0.0)
3. [ffmpeg](https://www.videohelp.com/software/ffmpeg) It is recommended to install the latest version.

Setup
=====
1. Install [Node.js](https://nodejs.org/download/) (minimum node version requirement: v9.4).
2. Download and unpack the [code](https://codeload.github.com/horacio9a/mfc-node/zip/v2).
3. Install requirements by running `npm install` in the same directory as `main.js` is (Windows users must install [Git](https://git-for-windows.en.lo4d.com/download)).
4. Edit `config.yml` file with the all necessary data.
5. `streamlink.exe`,`ffmpeg.exe` and `youtube-dl.exe` can be anywhere but the path's must be edited in `config.yml`.

Running
=======
1. Open Terminal (macOS) or Command Prompt (Windows) and go into the directory where you unpacked the files.
2. Run `node main.js`.
3. Open [http://localhost:8888](http://localhost:8888) in your web browser. The list of online models will be displayed with a set of allowed commands for each model:


- The online model list can be sorted by various criteria (default is 'state' because at the top are the models currently being recorded).
- If you looking for some models, click on the model name and a 'spinner' will appear with the model image with all available model data.
- If you want to start recording, click the red button ('Japanese flag'). For stop recording click the stop button (right of the red button).
- If some model doesn't want to recording constantly click red button right from 'Japanese flag' and after 24 hours that model will be expired (Mode in config.yml will become 0).
- All this can be done online and track what is happening on the console, and you can view recorded file immediately if you start some media player, for example VLC.
- When you click on a preview thumbnail the large model image is obtained in the next tab of your browser.
- The MFC Recorder now can record the MFC streams with three different programs (streamlink, ffmpeg and youtube-dl in mp4, flv and ts) depending on the data in config.yml ('sl', 'ff' or 'yt'). Currently it is best to use 'streamlink' because they don't have the so-called 'freeze' problem as it currently has 'ffmpeg'.
- By pressing 'State/Online' you can enter in the model room with your browser.
- By pressing the model 'Quality' you get a video preview of the current model in separate window of your browser. For this feature my recommendation is to use the Chrome browser with the installed add-on [Play HLS M3u8](https://chrome.google.com/webstore/detail/play-hls-m3u8/ckblfoghkjhaclegefojbgllenffajdc/related) but if you want firefox then need to install [Native HLS Playback](https://addons.mozilla.org/en-US/firefox/addon/native_hls_playback/)
- Streamlink users you can replace 'progress.py' for look better and to be useful because we will now know how is big files we are currently recording.

The list of online models will be displayed with a set of allowed commands for each model:
	Include - if you want to record the model
	Exclude - if you don't want to record the model anymore
	Delete - if you are not interested in the model and wanna hide her permanently

This is not a real-time application. Whenever your 'include', 'exclude' or 'delete' the model your changes will be applied only with the next iteration of 'mainLoop' function of the script. 'mainLoop' runs every 30 seconds (default value for 'modelScanInterval').
There is no 'auto reload' feature, you have to reload the list manually with 'big red button', however, keep in mind the script updates the list internally every 30 seconds ('modelScanInterval'), therefore sometimes you'll have to wait 30 seconds to see any updates.
Be mindful when capturing many streams at once to have plenty of space on disk and the bandwidth available or you’ll end up dropping a lot of frames and the files will be useless.

Converting
===========
I've made a unique script for convert and fix all three formats (ts, mp4 and flv) to the final `.flv` format, which can be easily watched or edited after. Mostly, the script processes all files regardless of whether they have audio or not. Newer versions of ffmpeg's have problem with some codec's like speex audio and I recommend old ffmpeg v.2.8.4 for that. The renamed files of ffmpeg v.2.8.4 is here: [ffmpeg284](https://www.mediafire.com/file/o9wifql28cx2qqh/ffmpeg-2.8.4-win32.rar/file). Just put `ffmpeg284.exe` in the same directory where is `ffmpeg.exe` located and edit 'ffmpeg284' in `config.yml` for `convertProgram`. After converting and fixing video files are ready for viewing or editing. Just edit `convert.yml` with appropriate values for `srcDirectory`, `dstDirectory` and choose ffmpeg version.

Proxy
=====
This is just a Proof of Concept to avoid region block.
To use it you have to start `proxy.js` on some remote server located in a different region then add a parameter `proxyServer` to your local `config.yml`, for example, `proxyServer: '54.206.109.161:9090'`.
The `main.js` script will try to get models from the remote region then merge them with the list of models available in your region.

Clickable places

![alt screenshot](./screenshot_0.jpg)

Sinner window layout

![alt screenshot](./screenshot_1.jpg)

Node.js window layout

![alt screenshot](./screenshot_2.jpg)
