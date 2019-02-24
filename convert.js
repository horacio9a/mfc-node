// MyFreeCams File Converter for ffmpeg v.3.4.1 and higher

'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var yaml = require('js-yaml');
var colors = require('colors');
var childProcess = require('child_process');
var mkdirp = require('mkdirp');
var mkdirpAsync = Promise.promisify(mkdirp);
var path = require('path');
var moment = require('moment');
var Queue = require('promise-queue');
var filewalker = require('filewalker');
var JSONStream = require('JSONStream');

var config = yaml.safeLoad(fs.readFileSync('convert.yml','utf8'));

var srcDirectory = path.resolve(config.srcDirectory || 'C:/Videos/MFC');
var dstDirectory = path.resolve(config.dstDirectory || 'C:/Videos/MFC_converted');
var dirScanInterval = config.dirScanInterval || 300;
var maxConcur = config.maxConcur || 1;

Queue.configure(Promise.Promise);

var queue = new Queue(maxConcur, Infinity);

function getCurrentTime() {return moment().format('HH:mm:ss')}

function printMsg(msg) {console.log(colors.gray('[' + getCurrentTime() + ']'), msg)}

function printErrorMsg(msg) {console.log(colors.gray('[' + getCurrentTime() + ']'), colors.red('[ERROR]'), msg)}

function getFiles() {let files = [];

  return new Promise((resolve, reject) => {
    filewalker(srcDirectory, { maxPending: 1, matchRegExp: /(\.ts|\.flv|\.mp4)$/ })
      .on('file', (p, stats) => {
        // select only "not hidden" files and not empty files (>10KBytes)
        if (!p.match(/(^\.|\/\.)/) && stats.size > 10240) {
          // push path relative to srcDirectory
          files.push(p);
        }
      })
      .on('done', () => {
        resolve(files);
      })
      .walk();
  });
}

function getAudioCodec(srcFile) {
  return new Promise((resolve, reject) => {
    let audioCodec = '';
    let spawnArguments = ['-v','error','-select_streams','a:0','-show_streams','-print_format','json',srcFile];

    let ffprobeProcess = childProcess.spawn('ffprobe', spawnArguments);

    ffprobeProcess.stdout.pipe(JSONStream.parse('streams.0')).on('data', data => {audioCodec = data.codec_name});

    ffprobeProcess.on('close', code => {
      if (code !== 0) {
        reject(`Failed to get audio codec from ${srcFile}`);
      } else {
        resolve(audioCodec);
      }
    });
  }).timeout(5000); // 5 seconds
}

function getSpawnArguments(srcFile, dstFile) {
  return getAudioCodec(srcFile)
    .then(audioCodec => (audioCodec === 'aac')
      ? ['-i', srcFile,'-y','-hide_banner','-loglevel','panic','-movflags','+faststart','-c:v','copy','-c:a','copy','-bsf:a','aac_adtstoasc','-copyts','-start_at_zero',dstFile]
      : ['-i', srcFile,'-y','-hide_banner','-loglevel','panic','-movflags','+faststart','-c:v','copy','-c:a','aac','-b:a','128k',dstFile])};

function convertFile(srcFile) {
  let startTs = moment();
  let src = path.join(srcDirectory, srcFile);

  let dstPath = path.resolve(path.dirname(path.join(dstDirectory, srcFile)));
  let dstFile = path.basename(srcFile, path.extname(srcFile)) + '.flv';

  let tempDst = path.join(dstPath, `~${dstFile}`);
  let dst = path.join(dstPath, dstFile);

  return mkdirpAsync(dstPath)
    .then(() => getSpawnArguments(src, tempDst))
    .then(spawnArguments => new Promise((resolve, reject) => {
      printMsg(`Starting ${colors.green(srcFile)} ...`);
      // printMsg('ffmpeg ' + spawnArguments.join(' '));

      let ffmpegProcess = childProcess.spawn('ffmpeg', spawnArguments);

      ffmpegProcess.on('close', code => {
        if (code !== 0) {
          reject(`Failed to convert ${srcFile}`);
        } else {
          let mtime;

          fs.statAsync(src)
            .then(stats => {
              // remember "modification time" of original file
              mtime = Math.ceil(stats.mtime.getTime() / 1000);
            })
            .then(() => config.deleteAfter ? fs.unlinkAsync(src) : fs.renameAsync(src, `${src}.bak`))
            .then(() => fs.renameAsync(tempDst, dst))
            .then(() => fs.utimesAsync(dst, mtime, mtime))
            .then(() => {
              let duration = moment.duration(moment().diff(startTs)).asSeconds().toString();

              printMsg(`Finished ${colors.green(dstFile)} after ${colors.magenta(duration)} sec.`);

              resolve();
            })
            .catch(err => {
              reject(err.toString());
            });
        }
      });
    }));
}

function mainLoop() {
  let startTs = moment().unix();

  Promise
    .try(() => getFiles())
    .then(files => new Promise((resolve, reject) => {
      printMsg(files.length + ' file(s) to convert');

      if (files.length === 0) {
        resolve();
      } else {
        files.forEach(file => {
          queue
            .add(() => convertFile(file))
            .then(() => {
              if ((queue.getPendingLength() + queue.getQueueLength()) === 0) {
                resolve();
              }
            })
            .catch(err => {
              printErrorMsg(err);
            });
        });
      }
    }))
    .catch(err => {
      if (err) {
        printErrorMsg(err);
      }
    })
    .finally(() => {
      let seconds = startTs - moment().unix() + dirScanInterval;

      if (seconds < 5) {
        seconds = 5;
      }

      printMsg(`Done, will scan the folder in ${seconds} seconds`);

      setTimeout(mainLoop, seconds * 1000);
    });
}

mkdirp.sync(srcDirectory);
mkdirp.sync(dstDirectory);

mainLoop();
