// MyFreeCams Recorder v.1.0.6

'use strict';
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var mv = require('mv');
var yaml = require('js-yaml');
var moment = require('moment');
var mkdirp = require('mkdirp');
var WebSocketClient = require('websocket').client;
var bhttp = require('bhttp');
var colors = require('colors');
var _ = require('underscore');
var spawn = require('child_process').spawn;
var path = require('path');
var http = require('http');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory = config.captureDirectory || 'C:\Videos\MFC';
config.createModelDirectory = config.createModelDirectory || false;
config.directoryFormat = config.directoryFormat || 'id+nm';
config.dateFormat = config.dateFormat || 'DDMMYYYY-HHmmss';
config.downloadProgram = config.downloadProgram || 'ls';
config.modelScanInterval = config.modelScanInterval || 30;
config.minFileSizeMb = config.minFileSizeMb || 0;
config.port = config.port || 8888;

config.includeModels = Array.isArray(config.includeModels) ? config.includeModels : [];
config.excludeModels = Array.isArray(config.excludeModels) ? config.excludeModels : [];
config.deleteModels = Array.isArray(config.deleteModels) ? config.deleteModels : [];

config.includeUids = Array.isArray(config.includeUids) ? config.includeUids : [];
config.excludeUids = Array.isArray(config.excludeUids) ? config.excludeUids : [];
config.deleteUids = Array.isArray(config.deleteUids) ? config.deleteUids : [];

var captureDirectory = path.resolve(config.captureDirectory);

function getCurrentDateTime() {
  return moment().format(config.dateFormat);
};

function getCurrentTime() {
  return moment().format('HH:mm:ss');
};

function printMsg(msg) {
  console.log(colors.gray(`[` + getCurrentTime() + `]`), msg);
};

function printErrorMsg(msg) {
  console.log(colors.gray(`[` + getCurrentTime() + `]`), colors.red(`[ERROR]`), msg);
};

function printDebugMsg(msg) {
  if (config.debug && msg) {
    console.log(colors.gray(`[` + getCurrentTime() + `]`), colors.magenta(`[DEBUG]`), msg);
  };
};

function getTimestamp() {
  return Math.floor(new Date().getTime() / 1000);
};

function dumpModelsCurrentlyCapturing() {
  _.each(modelsCurrentlyCapturing, function(m) {
    printMsg(`>>> ${colors.cyan(m.filename)} @ ${colors.yellow(config.downloadProgram)} recording <<<`);
  });
};

function getUid(nm) {
  var onlineModel = _.findWhere(onlineModels, {nm: nm});

  return _.isUndefined(onlineModel) ? false : onlineModel.uid;
}

function remove(value, array) {
  var idx = array.indexOf(value);

  if (idx != -1) {
    array.splice(idx, 1);
  }
}

// returns true, if the mode has been changed
function setMode(uid, mode) {
  var configModel = _.findWhere(config.models, {uid: uid});

  if (_.isUndefined(configModel)) {
    config.models.push({uid: uid, mode: mode});

    return true;
  } else if (configModel.mode != mode) {
    configModel.mode = mode;

    return true;
  }

  return false;
}

function getFileno() {
  return new Promise(function(resolve, reject) {
    var client = new WebSocketClient();

    client.on('connectFailed', function(err) {
      reject(err);
    });

    client.on('connect', function(connection) {

      connection.on('error', function(err) {
        reject(err);
      });

      connection.on('message', function(message) {
        if (message.type === 'utf8') {
          var parts = /%22opts%22:([0-9]*),%22respkey%22:([0-9]*),%22serv%22:([0-9]*),%22type%22:([0-9]*)\}/.exec(message.utf8Data);

          if (parts && parts[1] && parts[2] && parts[3] && parts[4]) {
            connection.close();
            resolve(`respkey=${parts[2]}&type=${parts[4]}&opts=${parts[1]}&serv=${parts[3]}`);
          }
        }
      });

      connection.sendUTF("hello fcserver\n\0");
      connection.sendUTF("1 0 0 20071025 0 guest:guest\n\0");
    });

    var servers = ["xchat20","xchat22","xchat23","xchat24","xchat25","xchat26","xchat27","xchat28","xchat29","xchat39",
                   "xchat62","xchat63","xchat64","xchat65","xchat66","xchat67","xchat68","xchat69","xchat70","xchat71",
                   "xchat72","xchat73","xchat74","xchat75","xchat76","xchat77","xchat78","xchat79","xchat80","xchat81",
                   "xchat83","xchat84","xchat85","xchat86","xchat87","xchat88","xchat89","xchat91","xchat94","xchat95",
                   "xchat96","xchat97","xchat98","xchat99","xchat100","xchat101","xchat102","xchat103","xchat104","xchat105",
                   "xchat106","xchat108","xchat109","xchat111","xchat100","xchat101","xchat102","xchat103","xchat104","xchat105",
                   "xchat106","xchat108","xchat109","xchat111","xchat112","xchat113","xchat114","xchat115","xchat116","xchat118",
                   "xchat119","xchat120","xchat121","xchat122","xchat123","xchat124","xchat125","xchat126","xchat127",
                   "ychat30","ychat31","ychat32","ychat33"];

    var server = _.sample(servers); // pick a random chat server

      printDebugMsg(`>>> ${colors.gray(`Start searching new models on server`)} ${colors.green(server)} <<<`);

    client.connect('ws://' + server + '.myfreecams.com:8080/fcsl','','http://' + server + '.myfreecams.com:8080',{Cookie: 'company_id=3149; guest_welcome=1; history=7411522,5375294'})
  }).timeout(20000); // 20 secs
}

function getOnlineModels(fileno) {
  var url = `http://www.myfreecams.com/php/FcwExtResp.php?${fileno}`;
    printDebugMsg(`>>> ${colors.gray(fileno)} <<<`);

  return Promise
    .try(function() {
      return session.get(url);
    })
    .then(function(response) {
      onlineModels = [];

      try {
        var data = JSON.parse(response.body.toString('utf8'));
        var m;

        for (var i = 1; i < data.rdata.length; i += 1) {
          m = data.rdata[i];
          onlineModels.push({
            nm: m[0],
            sid:m[1],
            uid:m[2],
            vs:m[3],
            pid:m[4],
            lv:m[5],
            camserv:m[6],
            phase:m[7],
            creation:m[11],
            photos:m[14],
            blurb:m[15],
            new_model:m[16],
            missmfc:m[17],
            camscore:m[18],
            continent: m[19],
            flags:m[20],
            rank:m[21],
            rc:m[22],
            topic:m[23]
          });
        }
      } catch (err) {
        throw new Error(`Failed to parse data.`);
      }

printMsg(`${colors.green(onlineModels.length)} models online.`);
    })
    .timeout(20000); // 20 secs
};

function selectMyModels() {
  return Promise
    .try(function() {
      printDebugMsg(`${config.models.length} models in ${colors.yellow(`config.`)}`);

// to include the model only knowing her name, we need to know her uid,
// if we could not find model's uid in array of online models we skip this model till the next iteration
      config.includeModels = _.filter(config.includeModels, function(nm) {
        var uid = getUid(nm);

        if (uid === false) {
          return true; // keep the model till the next iteration
        }

        config.includeUids.push(uid);
        dirty = true;
      });

      config.excludeModels = _.filter(config.excludeModels, function(nm) {
        var uid = getUid(nm);

        if (uid === false) {
          return true; // keep the model till the next iteration
        }

        config.excludeUids.push(uid);
        dirty = true;
      });

      config.deleteModels = _.filter(config.deleteModels, function(nm) {
        var uid = getUid(nm);

        if (uid === false) {
          return true; // keep the model till the next iteration
        }

        config.deleteUids.push(uid);
        dirty = true;
      });

      _.each(config.includeUids, function(uid) {
        dirty = setMode(uid, 1) || dirty;
      });

      config.includeUids = [];

      _.each(config.excludeUids, function(uid) {
        dirty = setMode(uid, 0) || dirty;
      });

      config.excludeUids = [];

      _.each(config.deleteUids, function(uid) {
        dirty = setMode(uid, -1) || dirty;
      });

      config.deleteUids = [];

      // remove duplicates
      if (dirty) {
        config.models = _.uniq(config.models, function(m) {
          return m.uid;
        });
      }

      var myModels = [];

      _.each(config.models, function(configModel) {
        var onlineModel = _.findWhere(onlineModels, {uid: configModel.uid});

        if (!_.isUndefined(onlineModel)) {
          // if the model does not have a name in config.models we use her name by default
          if (!configModel.nm) {
            configModel.nm = onlineModel.nm;
            dirty = true;
          }

          onlineModel.mode = configModel.mode;

          if (onlineModel.mode == 1) {
            if (onlineModel.vs === 0) {
              myModels.push(onlineModel);
            } else if (onlineModel.vs === 2) {
              printMsg(colors.green(`${onlineModel.nm} ${colors.cyan(`is Away.`)}`));
            } else if (onlineModel.vs === 12) {
              printMsg(colors.green(`${onlineModel.nm} ${colors.cyan(`is in Private.`)}`));
            } else if (onlineModel.vs === 13) {
              printMsg(colors.green(`${onlineModel.nm} ${colors.cyan(`is in Group Show.`)}`));
            } else if (onlineModel.vs === 14) {
              printMsg(colors.green(`${onlineModel.nm} ${colors.cyan(`is in Club Show.`)}`));
            } else if (onlineModel.vs === 90) {
              printMsg(colors.green(`${onlineModel.nm} ${colors.cyan(`is Cam Off.`)}`));
            }
          }
        }
      });

      printDebugMsg(`${myModels.length} model(s) to recording.`);

      if (dirty) {
        printDebugMsg(`Save changes in ${colors.yellow('config.')}`);

        fs.writeFileSync('config.yml', yaml.safeDump(config), 'utf8');

        dirty = false;
      }

      return myModels;
    });
}

function createCaptureProcess(model) {
  var modelCurrentlyCapturing = _.findWhere(modelsCurrentlyCapturing, {uid: model.uid});

  if (!_.isUndefined(modelCurrentlyCapturing)) {
    printDebugMsg(colors.green(model.nm) + ` >>> recording in progress.`);
    return; // resolve immediately
  }

  if ((model.camserv) < 840) {
    printDebugMsg(colors.green(model.nm) + (colors.cyan(` is NO MOBILE FEED - Exclude or Delete!`)));
    return;} // resolve immediately

  if ((model.camserv) > 1544) {
    printDebugMsg(colors.green(model.nm) + (colors.cyan(` is HD model - Exclude or Delete!`)));
    return;} // resolve immediately

var fileFormat;
   if (config.downloadProgram == 'ls') {
     fileFormat = 'mp4'}
   if (config.downloadProgram == 'sl') {
     fileFormat = 'mp4'}
   if (config.downloadProgram == 'ff-ts') {
     fileFormat = 'ts'}
   if (config.downloadProgram == 'ff-flv') {
     fileFormat = 'flv'}
   if (config.downloadProgram == 'hls') {
     fileFormat = 'mp4'}
   if (config.downloadProgram == 'rtmp') {
     fileFormat = 'flv'}

var dlProgram;
   if (config.downloadProgram == 'ls') {
     dlProgram = 'livestreamer'}
   if (config.downloadProgram == 'sl') {
     dlProgram = 'streamlink'}
   if (config.downloadProgram == 'ff-ts') {
     dlProgram = 'ffmpeg'}
   if (config.downloadProgram == 'ff-flv') {
     dlProgram = 'ffmpeg'}
   if (config.downloadProgram == 'hls') {
     dlProgram = 'hlsdl'}
   if (config.downloadProgram == 'rtmp') {
     dlProgram = 'rtmp'}

printMsg(colors.green(model.nm) + ` now online >>> Starting ${colors.yellow(dlProgram)} recording <<<`);

  return Promise
    .try(function() {
      var filename = model.nm + '_MFC_' + getCurrentDateTime() + '.' + fileFormat;

var directoryFormat;
   if (config.directoryFormat == 'id+nm') {
     directoryFormat = model.uid + '_' + model.nm}
   if (config.directoryFormat == 'id') {
     directoryFormat = model.uid}
   if (config.directoryFormat == 'nm') {
     directoryFormat = model.nm}
   if (config.directoryFormat == 'nm+id') {
     directoryFormat = model.nm + '_' + model.uid}

var path;
   if (config.createModelDirectory == false) {
     path = captureDirectory}
   if (config.createModelDirectory == true) {
     path = captureDirectory + '/' + directoryFormat}

mkdirp(path, function (err) {
   if (err) console.error(err)
   else { // do nothing
  }
});

var fpath = path + '/' + filename;

var roomId = 100000000 + model.uid;

var hlsUrl = `http://video${model.camserv - 500}.myfreecams.com:1935/NxServer/ngrp:mfc_${roomId}.f4v_mobile/playlist.m3u8?nc=${Date.now()}`;
var hlsUrla = `http://video${model.camserv - 1000}.myfreecams.com:1935/NxServer/ngrp:mfc_a_${roomId}.f4v_mobile/playlist.m3u8?nc=${Date.now()}`;

var captureProcess;

   if (config.downloadProgram == 'ls') {
     if (model.camserv > 1544) {
       captureProcess = spawn(dlProgram, ['-Q','hlsvariant://' + hlsUrla,'best','-o', fpath])}
     else {
       captureProcess = spawn(dlProgram, ['-Q','hlsvariant://' + hlsUrl,'best','--stream-sorting-excludes=>950p,>1500k','-o', fpath])}};

   if (config.downloadProgram == 'sl') {
     if (model.camserv > 1544) {
       captureProcess = spawn(dlProgram, ['-Q','hls://' + hlsUrla,'best','-o', fpath])}
     else {
       captureProcess = spawn(dlProgram, ['-Q','hls://' + hlsUrl,'best','--stream-sorting-excludes=>950p,>1500k','-o', fpath])}};

   if (config.downloadProgram == 'ff-ts') {
     captureProcess = spawn(dlProgram, ['-hide_banner','-v','fatal','-i',hlsUrl,'-map','0:1','-map','0:2','-c','copy','-vsync','2','-r','60','-b:v','500k', fpath])};

   if (config.downloadProgram == 'ff-flv') {
     captureProcess = spawn(dlProgram, ['-hide_banner','-v','fatal','-i',hlsUrl,'-c:v','copy','-map','0:1','-map','0:2','-c:a','aac','-b:a','192k','-ar','32000', fpath])};

   if (config.downloadProgram == 'hls') {
     captureProcess = spawn(dlProgram, [hlsUrl,'-b','-q','-o',fpath])};

   if (config.downloadProgram == 'rtmp') {
     captureProcess = spawn('mfcd', [model.nm, fpath])};

captureProcess.stdout.on('data', function(data) {
  printMsg(data.toString());
});

captureProcess.stderr.on('data', function(data) {
  printMsg(data.toString());
});

captureProcess.on('close', function(code) {
  printMsg(`${colors.green(model.nm)} <<< stopped recording.`);

var modelCurrentlyCapturing = _.findWhere(modelsCurrentlyCapturing, {
  pid: captureProcess.pid});

   if (!_.isUndefined(modelCurrentlyCapturing)) {
     var modelIndex = modelsCurrentlyCapturing.indexOf(modelCurrentlyCapturing);

   if (modelIndex !== -1) {
     modelsCurrentlyCapturing.splice(modelIndex, 1);
   }};

        fs.stat((fpath), function(err, stats) {
          if (err) {
            if (err.code == 'ENOENT') {
              // do nothing, file does not exists
            } else {
              printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
            }
          } else if (stats.size == 0 || stats.size < (config.minFileSizeMb * 1048576)) {
            fs.unlink(fpath), function(err) {}}})}); // do nothing, shit happens

      if (!!captureProcess.pid) {
        modelsCurrentlyCapturing.push({
          nm: model.nm,
          uid: model.uid,
          filename: filename,
          captureProcess: captureProcess,
          pid: captureProcess.pid,
          checkAfter: getTimestamp() + 600, // we are gonna check the process after 10 min
          size: 0
        });
      }
    })
    .catch(function(err) {
      printErrorMsg(`[` + colors.green(model.nm) + `] ` + err.toString());
    });
}

function checkCaptureProcess(model) {
  var onlineModel = _.findWhere(onlineModels, {uid: model.uid});

  if (!_.isUndefined(onlineModel)) {
    if (onlineModel.mode == 1) {
      onlineModel.capturing = true;
    } else if (!!model.captureProcess) {
      // if the model has been excluded or deleted we stop capturing process and resolve immediately
      printDebugMsg(colors.green(model.nm) + ` <<< has to be stopped.`);
      model.captureProcess.kill();
      return;
    }
  }

  // if this is not the time to check the process then we resolve immediately
  if (model.checkAfter > getTimestamp()) {
    return;
  }

  return fs
    .statAsync(path + '/' + model.filename)
    .then(function(stats) {
      // we check the process every 10 minutes since its start,
      // if the size of the file has not changed for the last 10 min, we kill the process
      if (stats.size - model.size > 0) {
        printDebugMsg(colors.green(model.nm) + ` is alive.`);

        model.checkAfter = getTimestamp() + 600; // 10 minutes
        model.size = stats.size;
      } else if (!!model.captureProcess) {
        // we assume that onClose will do all clean up for us
        printErrorMsg(`[` + colors.green(model.nm) + `] Process is dead.`);
        model.captureProcess.kill();
      } else {
        // suppose here we should forcefully remove the model from modelsCurrentlyCapturing
        // because her captureProcess is unset, but let's leave this as is
      }
    })
    .catch(function(err) {
      if (err.code == 'ENOENT') {
        // do nothing, file does not exists,
        // this is kind of impossible case, however, probably there should be some code to "clean up" the process
      } else {
        printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString());
      }
    });
}

function mainLoop() {

  Promise
    .try(function() {
      return getFileno();
    })
    .then(function(fileno) {
      return getOnlineModels(fileno);
    })
    .then(function() {
      return selectMyModels();
    })
    .then(function(myModels) {
      return Promise.all(myModels.map(createCaptureProcess));
    })
    .then(function() {
      return Promise.all(modelsCurrentlyCapturing.map(checkCaptureProcess));
    })
    .then(function() {
      models = onlineModels;
    })
    .catch(function(err) {
      printErrorMsg(err);
    })
    .finally(function() {
      dumpModelsCurrentlyCapturing();

printDebugMsg(`>>> ${colors.gray(`Will search for new models in ${config.modelScanInterval} seconds ...`)} <<<`);

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

var session = bhttp.session();

var models = new Array();
var onlineModels = new Array();
var modelsCurrentlyCapturing = new Array();

// convert the list of models to the new format
var dirty = false;

if (config.models.length > 0) {
  config.models = config.models.map(function(m) {

    if (typeof m === 'number') { // then this "simple" uid
      m = {uid: m, include: 1};

      dirty = true;
    } else if (_.isUndefined(m.mode)) { // if there is no mode field this old version
      m.mode = !m.excluded ? 1 : 0;
      dirty = true;
    }

    return m;
  });
}

   if (dirty) {printDebugMsg(`Save changes in ${colors.yellow(`config.`)}`); // then there were some changes in the list of models

fs.writeFileSync('config.yml', yaml.safeDump(config), 0, 'utf8');

dirty = false}

mainLoop();

dispatcher.onGet('/', function(req, res) {
  fs.readFile('./index.html', function(err, data) {
    if (err) {
      res.writeHead(404, {'Content-Type': 'text/html'});
      res.end('Not Found');
    } else {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(data, 'utf-8');
    }
  });
});

dispatcher.onGet('/favicon.ico', function(req, res) {
  fs.readFile('./favicon.ico', function(err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'image/x-icon' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      res.end(data);
    }
  });
});

// return an array of online models
dispatcher.onGet('/models', (req, res) => {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(models));
});

// when we include the model we only "express our intention" to do so,
// in fact the model will be included in the config only with the next iteration of mainLoop
dispatcher.onGet('/models/include', function(req, res) {
  if (req.params && req.params.uid) {
    var uid = parseInt(req.params.uid, 10);

    if (!isNaN(uid)) {
      printDebugMsg(`${colors.green(uid)}${colors.cyan(` >>> include >>>`)}`);

      // before we include the model we check that the model is not in our "to exclude" or "to delete" lists
      remove(req.params.nm, config.excludeUids);
      remove(req.params.nm, config.deleteUids);

      config.includeUids.push(uid);

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({uid: uid})); // this will be sent back to the browser

      var model = _.findWhere(models, {uid: uid});

      if (!_.isUndefined(model)) {
        model.nextMode = 1;
      }

      return;
    }
  } else if (req.params && req.params.nm) {
    printDebugMsg(`${colors.green(req.params.nm)}${colors.cyan(` >>> include >>>`)}`);

    // before we include the model we check that the model is not in our "to exclude" or "to delete" lists
    remove(req.params.nm, config.excludeModels);
    remove(req.params.nm, config.deleteModels);

    config.includeModels.push(req.params.nm);

    dirty = true;

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({nm: req.params.nm})); // this will be sent back to the browser

    var model = _.findWhere(models, {nm: req.params.nm});

    if (!_.isUndefined(model)) {
      model.nextMode = 1;
    }

    return;
  }

  res.writeHead(422, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: 'Invalid request'}));
});

// whenever we exclude the model we only "express our intention" to do so,
// in fact the model will be exclude from config only with the next iteration of mainLoop
dispatcher.onGet('/models/exclude', function(req, res) {
  if (req.params && req.params.uid) {
    var uid = parseInt(req.params.uid, 10);

    if (!isNaN(uid)) {
      printDebugMsg(`${colors.green(uid)}${colors.cyan(` <<< exclude <<<`)}`);

      // before we exclude the model we check that the model is not in our "to include" or "to delete" lists
      remove(req.params.nm, config.includeUids);
      remove(req.params.nm, config.deleteUids);

      config.excludeUids.push(uid);

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({uid: uid})); // this will be sent back to the browser

      var model = _.findWhere(models, {uid: uid});

      if (!_.isUndefined(model)) {
        model.nextMode = 0;
      }

      return;
    }
  } else if (req.params && req.params.nm) {
    printDebugMsg(`${colors.green(req.params.nm)}${colors.cyan(` <<< exclude <<<`)}`);

    // before we exclude the model we check that the model is not in our "to include" or "to delete" lists
    remove(req.params.nm, config.includeModels);
    remove(req.params.nm, config.deleteModels);

    config.excludeModels.push(req.params.nm);

    dirty = true;

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({nm: req.params.nm})); // this will be sent back to the browser

    var model = _.findWhere(models, {nm: req.params.nm});

    if (!_.isUndefined(model)) {
      model.nextMode = 0;
    }

    return;
  }

  res.writeHead(422, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({error: `Invalid request.`}));
});

// whenever we delete the model we only "express our intention" to do so,
// in fact the model will be markd as "deleted" in config only with the next iteration of mainLoop
dispatcher.onGet('/models/delete', function(req, res) {
  if (req.params && req.params.uid) {
    var uid = parseInt(req.params.uid, 10);

   if (!isNaN(uid)) {
     printDebugMsg(`${colors.green(uid)}${colors.red(` >>> delete <<<`)}`);

      // before we exclude the model we check that the model is not in our "to include" or "to exclude" lists
      remove(req.params.nm, config.includeUids);
      remove(req.params.nm, config.excludeUids);

      config.deleteUids.push(uid);

      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({uid: uid})); // this will be sent back to the browser

      var model = _.findWhere(models, {uid: uid});

      if (!_.isUndefined(model)) {
        model.nextMode = -1;
      }

      return;
    }
  } else if (req.params && req.params.nm) {
    printDebugMsg(`${colors.green(req.params.nm)}${colors.red(` >>> delete <<<`)}`);

    // before we exclude the model we check that the model is not in our "include" or "exclude" lists
    remove(req.params.nm, config.includeModels);
    remove(req.params.nm, config.excludeModels);

    config.deleteModels.push(req.params.nm);

    dirty = true;

    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({nm: req.params.nm})); // this will be sent back to the browser

    var model = _.findWhere(models, {nm: req.params.nm});

    if (!_.isUndefined(model)) {
      model.nextMode = -1;
    }

    return;
  }

   res.writeHead(422, {'Content-Type': 'application/json'});
   res.end(JSON.stringify({error: `Invalid request.`}));
});

dispatcher.onError(function(req, res) {
  res.writeHead(404);
});

http.createServer((req, res) => {
  dispatcher.dispatch(req, res);
}).listen(config.port, () => {
  printMsg(`Server listening on: ` + colors.green(`0.0.0.0:` + config.port));
});
