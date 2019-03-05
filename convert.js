// MyFreeCams File Converter v.3.0.3

'use strict';

let Promise = require('bluebird');
let fs = Promise.promisifyAll(require('fs'));
let yaml = require('js-yaml');
let colors = require('colors');
let childProcess = require('child_process');
let mkdirp = require('mkdirp');
let path = require('path');
let moment = require('moment');
let Queue = require('promise-queue');
let filewalker = require('filewalker');

function getCurrentTime() {
  return moment().format(`HH:mm:ss`);
}

function printMsg(msg) {
  console.log(colors.gray(`[` + getCurrentTime() + `]`), msg);
}

function printErrorMsg(msg) {
  console.log(colors.gray(`[` + getCurrentTime() + `]`), colors.red(`[ERROR]`), msg);
}

function getTimestamp() {
  return Math.floor(new Date().getTime() / 1000);
}

let config = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'convert.yml'), 'utf8'));

let srcDirectory = path.resolve(__dirname, config.srcDirectory || 'complete');
let dstDirectory = path.resolve(__dirname, config.dstDirectory || 'converted');
let convertProgram = config.convertProgram || 'ffmpeg284';
let dirScanInterval = config.dirScanInterval || 300;
let maxConcur = config.maxConcur || 1;

Queue.configure(Promise.Promise);

let queue = new Queue(maxConcur, Infinity);

function getFiles() {
  let files = [];

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

function convertFile(srcFile) {
  let startTs = moment();
  let src = path.join(srcDirectory, srcFile);
  let dstPath = path.resolve(path.dirname(path.join(dstDirectory, srcFile)));
  let dstFile = path.basename(srcFile, path.extname(srcFile)) + '.flv';
  let dst = path.join(dstDirectory, `~${dstFile}`);
  let tempDst = path.join(dstPath, dstFile);

  mkdirp.sync(dstPath);

  printMsg(`Starting ${colors.gray(srcFile)}`);

  let convertProcess;

  if (convertProgram == 'ffmpeg') {
    convertProcess = childProcess.spawnSync(convertProgram,['-i',src,'-y','-hide_banner','-loglevel','panic','-c:v','copy','-c:a','aac','-b:a','128k','-copyts','-start_at_zero',dst])};

  if (convertProgram == 'ffmpeg284') {
    convertProcess = childProcess.spawnSync(convertProgram,['-i',src,'-y','-hide_banner','-loglevel','panic','-c:v','copy','-c:a','libvo_aacenc','-b:a','128k','-copyts','-start_at_zero',dst])};

  let duration = moment.duration(moment().diff(startTs)).asSeconds().toString();
  printMsg(`Finished ${colors.green(dstFile)} after ${colors.cyan(duration)} sec.`);

  if (convertProcess.status != 0) {
    printErrorMsg(`Failed to convert ${colors.red(srcFile)}`);

  if (convertProcess.error) {
    printErrorMsg(convertProcess.error.toString());
  }

  return;
}

  if (config.deleteAfter) {
    fs.unlink(src, function(err) {
      // do nothing, shit happens
    });
  } else {
    fs.renameAsync(src, `${src}.bak`, function(err) {
      if (err) {
        printErrorMsg(err.toString());
      }
    });
  }

  fs.renameAsync(dst, tempDst, function(err) {
    if (err) {
      printErrorMsg(err.toString());
    }
  });
}

function mainLoop() {
  let startTs = moment().unix();

  Promise
    .try(() => getFiles())
    .then(files => new Promise((resolve, reject) => {
      printMsg(files.length + ` file(s) to convert.`);

      if (files.length === 0) {
        resolve();
      } else {
        files.forEach(file => {
          queue
            .add(() => convertFile(file))
            .catch(err => {
              printErrorMsg(err);
            })
            .finally(() => {
              if ((queue.getPendingLength() + queue.getQueueLength()) === 0) {
                resolve();
              }
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

      printMsg(`Done >>> will scan the folder in ${seconds} seconds.`);

      setTimeout(mainLoop, seconds * 1000);
    });
}

mkdirp.sync(srcDirectory);
mkdirp.sync(dstDirectory);

mainLoop();
