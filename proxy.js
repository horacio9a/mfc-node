// MyFreeCams Recorder v.3.0.3

'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var moment = require('moment');
var colors = require('colors');
var yaml = require('js-yaml');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();
var http = require('http');
var mfc = require('MFCAuto');
var compression = require('compression');

var useDefaultOptions = {};
var compress = compression(useDefaultOptions);
var noop = () => {};

var onlineModels = []; // the list of online models from myfreecams.com

var config = yaml.safeLoad(fs.readFileSync('proxy.yml', 'utf8'));

config.proxyPort = config.proxyPort || 8889;
config.modelScanInterval = config.modelScanInterval || 30;
config.debug = !!config.debug;

var mfcClient = new mfc.Client();

function getCurrentTime() {
  return moment().format(`HH:mm:ss`);
}

function printMsg(msg) {
  console.log(colors.gray(`[` + getCurrentTime() + `]`), msg);
}

function printErrorMsg(msg) {
  console.log(colors.gray('[' + getCurrentTime() + ']'), colors.red(`[ERROR]`), msg);
}

function printDebugMsg(msg) {
  if (config.debug && msg) {
    console.log(colors.gray('[' + getCurrentTime() + ']'), colors.magenta(`[DEBUG]`), msg);
  }
}

function getOnlineModels() {
  let models = [];

  mfc.Model.knownModels.forEach(m => {
    if (m.bestSession.vs !== mfc.STATE.Offline && m.bestSession.camserv > 0 && !!m.bestSession.nm) {
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
        age: m.bestSession.age,
        city: m.bestSession.city,
        country: m.bestSession.country,
        blurb: m.bestSession.blurb,
        occupation: m.bestSession.occupation,
        ethnic: m.bestSession.ethnic,
        phase: m.bestSession.phase,
        rank: m.bestSession.rank,
        rc: m.bestSession.rc,
        tags: m.bestSession.tags
      });
    }
  });

  onlineModels = models;

  printMsg(`${onlineModels.length} model(s) online.`);
}

function mainLoop() {
  printDebugMsg(`Start new cycle.`);

  Promise
    .try(getOnlineModels)
    .catch(printErrorMsg)
    .finally(() => {
      printMsg(`Done >>> will search for new models in ${config.modelScanInterval} seconds <<<`);

      setTimeout(mainLoop, config.modelScanInterval * 1000);
    });
}

Promise
  .try(() => mfcClient.connectAndWaitForModels())
  .timeout(120000) // if we could not get a list of online models in 2 minutes then exit
  .then(() => mainLoop())
  .catch(err => {
    printErrorMsg(err.toString());
    process.exit(1);
  });

dispatcher.onGet('/models', (req, res) => {
  compress(req, res, noop);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(onlineModels));
});

http.createServer((req, res) => {
  dispatcher.dispatch(req, res);
}).listen(config.port, () => {
  printMsg(`Server listening on: ` + colors.green(`0.0.0.0:` + config.port));
});
