'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var mv = require('mv');
var moment = require('moment');
var colors = require('colors');
var mkdirp = require('mkdirp');
var yaml = require('js-yaml');
var _ = require('underscore');
var path = require('path');
var bhttp = require('bhttp');
var session = bhttp.session();
var childProcess = require('child_process');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();
var http = require('http');
var mfc = require('MFCAuto');

// mfc.setLogLevel(5);

var onlineModels = []; // the list of models from myfreecams.com
var capturingModels = []; // the list of currently capturing models
var cachedModels = [];  // "cached" copy of onlineModels (primarily for index.html)

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory = config.captureDirectory || 'C:\Videos\MFC';
config.dateFormat = config.dateFormat || 'DDMMYYYY-HHmmss';
config.modelScanInterval = config.modelScanInterval || 30;
config.port = config.port || 9080;
config.minFileSizeMb = config.minFileSizeMb || 0;
config.debug = config.debug || false;
config.rtmp = config.rtmp || false;
config.models = Array.isArray(config.models) ? config.models : [];
config.queue = Array.isArray(config.queue) ? config.queue : [];

var captureDirectory = path.resolve(config.captureDirectory);

function mkdir(dir) {
  mkdirp(dir, err => {
    if (err) {
      printErrorMsg(err);
      process.exit(1);
    }
  });
}

function getCurrentTime() {return moment().format('HH:mm:ss');};

function printMsg(msg) {console.log(colors.gray(`[${getCurrentTime()}]`), msg);}

function printErrorMsg(msg) {console.log(colors.gray(`[${getCurrentTime()}]`), colors.red('[ERROR]'), msg);}

function printDebugMsg(msg) {
  if (config.debug && msg) {
    console.log(colors.gray(`[${getCurrentTime()}]`), colors.magenta('[DEBUG]'), msg);
  }
}

function remove(value, array) {var idx = array.indexOf(value);

  if (idx !== -1) {array.splice(idx, 1);}}

function getOnlineModels() {var models = [];

  mfc.Model.knownModels.forEach(m => {
    if (m.bestSession.vs !== mfc.STATE.Offline && m.bestSession.camserv > 0) {
      if (!m.bestSession.nm) {
        printErrorMsg(m.bestSession);
      }

      models.push({
        nm: m.bestSession.nm,
        sid: m.bestSession.sid,
        uid: m.bestSession.uid,
        vs: m.bestSession.vs,
        camserv: m.bestSession.camserv,
        topic: m.bestSession.topic,
        missmfc: m.bestSession.missmfc,
        new_model: m.bestSession.new_model,
        camscore: m.bestSession.camscore,
        continent: m.bestSession.continent,
        rank: m.bestSession.rank,
        rc: m.bestSession.rc,
        tags: m.bestSession.tags
      });
    }
  });

  onlineModels = models;

  printMsg(`${onlineModels.length} model(s) online.`);
}

// goes through the models in the queue and updates their settings in config
function updateConfigModels() {
  printDebugMsg(`${config.queue.length} model(s) in queue.`);

  var isDirty = false;

  // move models from the queue to config
  config.queue = _.filter(config.queue, queueModel => {
    var uid = queueModel.uid;

    if (_.isUndefined(uid)) {
      let onlineModel = _.findWhere(onlineModels, { nm: queueModel.nm });

      if (_.isUndefined(onlineModel)) {
        return true;
      }

      uid = onlineModel.uid;
    }

    var configModel = _.findWhere(config.models, { uid: uid });

    if (_.isUndefined(configModel)) {
      config.models.push({ uid: uid, mode: queueModel.mode });
    } else {
      configModel.mode = queueModel.mode;
    }

    isDirty = true;
  });

  if (isDirty) {
    // remove duplicates,
    // we should not have duplicates, but just in case...
    config.models = _.uniq(config.models, m => {
      return m.uid;
    });

    printDebugMsg('Save changes in config.yml');

    fs.writeFileSync('config.yml', yaml.safeDump(config), 'utf8');
  }
}

function selectMyModels() {
  printDebugMsg(`${config.models.length} model(s) in config.yml`);

  var myModels = [];
  var isDirty = false;

  _.each(config.models, configModel => {
    var onlineModel = _.findWhere(onlineModels, { uid: configModel.uid });

    // if undefined then the model is offline
    if (_.isUndefined(onlineModel)) {
      return; // skip the rest of the function
    }

    onlineModel.mode = configModel.mode;

    if (onlineModel.mode === 1) {
      if (onlineModel.vs === 0 || onlineModel.vs === 90) { // probably 90 should be removed
        myModels.push(onlineModel);
      } else {
        printMsg(`${colors.green(onlineModel.nm)} is AWAY or PRIVATE.`);
      }
    }

    // save the name of the model in config
    if (!configModel.nm) {
      configModel.nm = onlineModel.nm;
      isDirty = true;
    }
  });

  if (isDirty) {
    printDebugMsg('Save changes in config.yml');

    fs.writeFileSync('config.yml', yaml.safeDump(config), 'utf8');
  }

  printDebugMsg(myModels.length + ' model(s) to record.');

  return myModels;
}

function createRtmpCaptureProcess(myModel) {
  // "classified", currently I'm not interested to make this part public
}

function createFfmpegCaptureProcess(myModel) {
  return Promise
    .try(() => {
      var filename = myModel.nm + '_MFC_' + moment().format(config.dateFormat) + '.flv';

      var captureProcess = childProcess.spawn('ffmpeg', [
        '-hide_banner',
        '-v',
        'fatal',
        '-i',
        'http://video' + (myModel.camserv - 500) + '.myfreecams.com:1935/NxServer/ngrp:mfc_' + (100000000 + myModel.uid) + '.f4v_mobile/playlist.m3u8',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        config.captureDirectory + '/' + filename
      ]);

      if (!captureProcess.pid) {
        return;
      }

      captureProcess.stdout.on('data', data => {
        printMsg(data.toString());
      });

      captureProcess.stderr.on('data', data => {
        printMsg(data.toString());
      });

      captureProcess.on('close', code => {
        printMsg(`${colors.green(myModel.nm)} <<< stopped recording.`);

        var stoppedModel = _.findWhere(capturingModels, { captureProcess: captureProcess });

        if (!_.isUndefined(stoppedModel)) {
          remove(stoppedModel, capturingModels);
        }

        fs.statAsync(`${captureDirectory}/${filename}`)
          .then(stats => {
            if (stats.size <= (config.minFileSizeMb * 1048576)) {
              fs.unlink(captureDirectory + '/' + filename, err => {
                // do nothing, shit happens
              });
            } 
          })
          .catch(err => {
            if (err.code !== 'ENOENT') {
              printErrorMsg('[' + colors.green(myModel.nm) + '] ' + err.toString());
            }
          });
      });

      capturingModels.push({
        nm: myModel.nm,
        uid: myModel.uid,
        filename: filename,
        captureProcess: captureProcess,
        checkAfter: moment().unix() + 600, // we are gonna check this process after 10 min
        size: 0
      });
    })
    .catch(err => {
      printErrorMsg('[' + colors.green(myModel.nm) + '] ' + err.toString());
    });
}

function createCaptureProcess(myModel) {
  var capturingModel = _.findWhere(capturingModels, { uid: myModel.uid });

  if (capturingModel !== undefined) {
  printDebugMsg(colors.yellow(capturingModel.filename) + ' ' + (capturingModel.size/1048576).toFixed(1) + ' MB');

    return; // resolve immediately
  }

  printMsg(colors.green(myModel.nm) + ' is online >>> start recording.');

  return config.rtmp ? createRtmpCaptureProcess(myModel) : createFfmpegCaptureProcess(myModel);
}

function checkCaptureProcess(capturingModel) {
  var onlineModel = _.findWhere(onlineModels, { uid: capturingModel.uid });

  if (onlineModel !== undefined) {
    if (onlineModel.mode === 1) {
      onlineModel.capturing = true;
    } else if (capturingModel.captureProcess) {
      // if the model has been excluded or deleted we stop capturing process and resolve immediately
      printDebugMsg(colors.green(capturingModel.nm) + ' has to be stopped.');

      capturingModel.captureProcess.kill();

      return;
    }
  }

  // if this is not the time to check the process then we resolve immediately
  if (capturingModel.checkAfter > moment().unix()) {
    return;
  }

  return fs
    .statAsync(captureDirectory + '/' + capturingModel.filename)
    .then(stats => {
      // we check the process every 10 minutes since its start,
      // if the size of the file has not changed for the last 10 min, we kill the process
      if (stats.size - capturingModel.size > 0) {
        printDebugMsg(colors.green(capturingModel.nm) + ' is alive.');

        capturingModel.checkAfter = moment().unix() + 300; // 5 minutes
        capturingModel.size = stats.size;
      } else if (capturingModel.captureProcess) {
        // we assume that onClose will do all clean up for us
        printErrorMsg('[' + colors.green(capturingModel.nm) + '] Process is dead.');
        capturingModel.captureProcess.kill();
      } else {
        // suppose here we should forcefully remove the model from capturingModels
        // because her captureProcess is unset, but let's leave this as is
        // remove(capturingModel, capturingModels);
      }
    })
    .catch(err => {
      if (err.code === 'ENOENT') {
        // do nothing, file does not exists,
        // this is kind of impossible case, however, probably there should be some code to "clean up" the process
      } else {
        printErrorMsg('[' + colors.green(capturingModel.nm) + '] ' + err.toString());
      }
    });
}

function addInQueue(req, res) {
  var model;
  var mode = 0;

  if (req.url.startsWith('/models/include')) {
    mode = 1;
  } else if (req.url.startsWith('/models/delete')) {
    mode = -1;
  }

  if (req.params && req.params.uid) {
    let uid = parseInt(req.params.uid, 10);

    if (!isNaN(uid)) {
      model = { uid: uid, mode: mode };
    }
  } else if (req.params && req.params.nm) {
    model = { nm: req.params.nm, mode: mode };
  }

  if (_.isUndefined(model)) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request.' }));
  } else {
    printDebugMsg(colors.green(model.uid || model.nm) + ' to ' + (mode === 1 ? 'include.' : (mode === 0 ? 'exclude.' : 'delete.')));

    config.queue.push(model);

    let localModel = _.findWhere(cachedModels, !model.uid ? { nm: model.nm } : { uid: model.uid });

    if (localModel !== undefined) {
      localModel.nextMode = mode;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(model)); // this will be sent back to the browser
  }
}

function mainLoop() {
  printDebugMsg('Start new cycle.');

  Promise
    .try(() => getOnlineModels())
    .then(() => updateConfigModels()) // move models from the queue to config
    .then(() => selectMyModels())
    .then(myModels => Promise.all(myModels.map(createCaptureProcess)))
    .then(() => Promise.all(capturingModels.map(checkCaptureProcess)))
    .then(() => {
      cachedModels = _.reject(onlineModels, onlineModel => (onlineModel.mode === -1));
    })
    .catch(err => {
      printErrorMsg(err);
    })
    .finally(() => {
      printMsg('Done >>> will search for new models in ' + config.modelScanInterval + ' seconds.');

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

var mfcClient = new mfc.Client();

Promise
  .try(() => mfcClient.connectAndWaitForModels())
  .timeout(120000) // 2 mins
  .then(() => {
    mkdir(captureDirectory);

    mainLoop();
  })
  .catch(err => {
    printErrorMsg(err.toString());
  });

dispatcher.onGet('/', (req, res) => {
  fs.readFile('./index.html', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('Not Found.');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data, 'utf-8');
    }
  });
});

// return an array of online models
dispatcher.onGet('/models', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(cachedModels));
});

// when we include the model we only "express our intention" to do so,
// in fact the model will be included in the config only with the next iteration of mainLoop
dispatcher.onGet('/models/include', addInQueue);

// whenever we exclude the model we only "express our intention" to do so,
// in fact the model will be exclude from config only with the next iteration of mainLoop
dispatcher.onGet('/models/exclude', addInQueue);

// whenever we delete the model we only "express our intention" to do so,
// in fact the model will be markd as "deleted" in config only with the next iteration of mainLoop
dispatcher.onGet('/models/delete', addInQueue);

dispatcher.onError((req, res) => {
  res.writeHead(404);
});

http.createServer((req, res) => {
  dispatcher.dispatch(req, res);
}).listen(config.port, () => {
  printMsg('Server listening on: ' + colors.cyan('0.0.0.0:' + config.port));
});
