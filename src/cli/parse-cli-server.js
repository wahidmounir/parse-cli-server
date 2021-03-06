import fs from 'fs-extra';
import path from 'path';
import express from 'express';
import cluster from 'cluster';
import os from 'os';
import runner from 'parse-server/lib/cli/utils/runner';

import AppCache from 'parse-server/lib/cache';
import { ParseServer } from 'parse-server/lib/index';
import ParseCliServer from '../ParseCliServer';
import LocalVendorAdapter from '../LocalVendorAdapter';
import definitions from './definitions/parse-cli-server';

const help = function(){
  console.log('  Get Started guide:');
  console.log('');
  console.log('    Please have a look at the get started guide!')
  console.log('    https://github.com/ParsePlatform/parse-server/wiki/Parse-Server-Guide');
  console.log('');
  console.log('');
  console.log('  Usage with npm start');
  console.log('');
  console.log('    $ npm start -- path/to/config.json');
  console.log('    $ npm start -- --appPath /my/parse-app --masterKey MASTER_KEY --serverURL serverURL');
  console.log('    $ npm start -- --appPath /my/parse-app --masterKey MASTER_KEY --serverURL serverURL');
  console.log('');
  console.log('');
  console.log('  Usage:');
  console.log('');
  console.log('    $ parse-cli-server path/to/config.json');
  console.log('    $ parse-cli-server -- --appPath /my/parse-app --masterKey MASTER_KEY --serverURL serverURL');
  console.log('    $ parse-cli-server -- --appPath /my/parse-app --masterKey MASTER_KEY --serverURL serverURL');
  console.log('');
};

function startServer(options, callback) {
  const app = express();
  const sockets = {};

  const api = new ParseServer(options);
  let config = AppCache.get(options.appId);

  const cliServer = new ParseCliServer({
    config: config,
    vendorAdapter: new LocalVendorAdapter({
      config,
      appPath: options.appPath,
      cloud: options.cloud,
    }),
  });

  app.use(options.mountPath, cliServer.app);
  app.use(options.mountPath, api);

  var server = app.listen(options.port, callback);
  server.on('connection', initializeConnections);

  if (options.startLiveQueryServer || options.liveQueryServerOptions) {
    let liveQueryServer = server;
    if (options.liveQueryPort) {
      liveQueryServer = express().listen(options.liveQueryPort, () => {
        console.log('ParseLiveQuery listening on ' + options.liveQueryPort);
      });
    }
    ParseServer.createLiveQueryServer(liveQueryServer, options.liveQueryServerOptions);
  }

  function initializeConnections(socket) {
    /* Currently, express doesn't shut down immediately after receiving SIGINT/SIGTERM if it has client connections that haven't timed out. (This is a known issue with node - https://github.com/nodejs/node/issues/2642)

      This function, along with `destroyAliveConnections()`, intend to fix this behavior such that parse server will close all open connections and initiate the shutdown process as soon as it receives a SIGINT/SIGTERM signal. */

    const socketId = socket.remoteAddress + ':' + socket.remotePort;
    sockets[socketId] = socket;

    socket.on('close', () => {
      delete sockets[socketId];
    });
  }

  function destroyAliveConnections() {
    for (const socketId in sockets) {
      try {
        sockets[socketId].destroy();
      } catch (e) { }
    }
  }

  var handleShutdown = function() {
    console.log('Termination signal received. Shutting down.');
    destroyAliveConnections();
    server.close(function () {
      process.exit(0);
    });
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}


runner({
  definitions,
  help,
  usage: '[options] <path/to/configuration.json>',
  start: function(program, options, logOptions) {
    if (!options.serverURL) {
      options.serverURL = `http://localhost:${options.port}${options.mountPath}`;
    }
    if (!options.appPath) {
      options.appPath = process.cwd();
    }

    let parseLocalFile = path.join(options.appPath, '.parse.local');
  
    if (fs.existsSync(parseLocalFile)) {
      let parseLocalConfig = JSON.parse(fs.readFileSync(parseLocalFile));
      options.appName = parseLocalConfig.applications._default.link;

      let appConfig = parseLocalConfig.applications[options.appName];
      options.appId = appConfig.applicationId;
      delete appConfig.applicationId;

      for (var key in appConfig) {
        options[key] = options[key] || appConfig[key];
      }
    }

    if (!options.appId || !options.masterKey || !options.serverURL) {
      program.outputHelp();
      console.error("");
      console.error('\u001b[31mERROR: appId and masterKey are required\u001b[0m');
      console.error("");
      process.exit(1);
    }

    options.cloud = path.join(options.appPath, 'cloud', options.cloud);
    fs.ensureFileSync(options.cloud);

    if (options["liveQuery.classNames"]) {
      options.liveQuery = options.liveQuery || {};
      options.liveQuery.classNames = options["liveQuery.classNames"];
      delete options["liveQuery.classNames"];
    }
    if (options["liveQuery.redisURL"]) {
      options.liveQuery = options.liveQuery || {};
      options.liveQuery.redisURL = options["liveQuery.redisURL"];
      delete options["liveQuery.redisURL"];
    }

    if (options.cluster) {
      const numCPUs = typeof options.cluster === 'number' ? options.cluster : os.cpus().length;
      if (cluster.isMaster) {
        for(var i = 0; i < numCPUs; i++) {
          cluster.fork();
        }
        cluster.on('exit', (worker, code, signal) => {
          console.log(`worker ${worker.process.pid} died... Restarting`);
          cluster.fork();
        });
      } else {
        startServer(options, () => {
          console.log('['+process.pid+'] parse-server running on '+options.serverURL);
        });
      }
    } else {
      startServer(options, () => {
        logOptions();
        console.log('');
        console.log('['+process.pid+'] parse-server running on '+options.serverURL);
      });
    }
  }
})
