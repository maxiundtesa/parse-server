import AppCache from './cache';
import Parse from 'parse/node';
import auth from './Auth';
import Config from './Config';
import ClientSDK from './ClientSDK';
import defaultLogger from './logger';

export const DEFAULT_ALLOWED_HEADERS =
  'X-Parse-Master-Key, X-Parse-REST-API-Key, X-Parse-Javascript-Key, X-Parse-Application-Id, X-Parse-Client-Version, X-Parse-Session-Token, X-Requested-With, X-Parse-Revocable-Session, Content-Type, Pragma, Cache-Control';

const getMountForRequest = function(req) {
  const mountPathLength = req.originalUrl.length - req.url.length;
  const mountPath = req.originalUrl.slice(0, mountPathLength);
  return req.protocol + '://' + req.get('host') + mountPath;
};

// Checks that the request is authorized for this app and checks user
// auth too.
// The bodyparser should run before this middleware.
// Adds info to the request:
// req.config - the Config for this app
// req.auth - the Auth for this request
export function handleParseHeaders(req, res, next) {
  var mount = getMountForRequest(req);

  var info = {
    appId: req.get('X-Parse-Application-Id'),
    sessionToken: req.get('X-Parse-Session-Token'),
    masterKey: req.get('X-Parse-Master-Key'),
    installationId: req.get('X-Parse-Installation-Id'),
    clientKey: req.get('X-Parse-Client-Key'),
    javascriptKey: req.get('X-Parse-Javascript-Key'),
    dotNetKey: req.get('X-Parse-Windows-Key'),
    restAPIKey: req.get('X-Parse-REST-API-Key'),
    clientVersion: req.get('X-Parse-Client-Version'),
  };

  var basicAuth = httpAuth(req);

  if (basicAuth) {
    var basicAuthAppId = basicAuth.appId;
    if (AppCache.get(basicAuthAppId)) {
      info.appId = basicAuthAppId;
      info.masterKey = basicAuth.masterKey || info.masterKey;
      info.javascriptKey = basicAuth.javascriptKey || info.javascriptKey;
    }
  }

  if (req.body) {
    // Unity SDK sends a _noBody key which needs to be removed.
    // Unclear at this point if action needs to be taken.
    delete req.body._noBody;
  }

  var fileViaJSON = false;

  if (!info.appId || !AppCache.get(info.appId)) {
    // See if we can find the app id on the body.
    if (req.body instanceof Buffer) {
      // The only chance to find the app id is if this is a file
      // upload that actually is a JSON body. So try to parse it.
      req.body = JSON.parse(req.body);
      fileViaJSON = true;
    }

    if (req.body) {
      delete req.body._RevocableSession;
    }

    if (
      req.body &&
      req.body._ApplicationId &&
      AppCache.get(req.body._ApplicationId) &&
      (!info.masterKey ||
        AppCache.get(req.body._ApplicationId).masterKey === info.masterKey)
    ) {
      info.appId = req.body._ApplicationId;
      info.javascriptKey = req.body._JavaScriptKey || '';
      delete req.body._ApplicationId;
      delete req.body._JavaScriptKey;
      // TODO: test that the REST API formats generated by the other
      // SDKs are handled ok
      if (req.body._ClientVersion) {
        info.clientVersion = req.body._ClientVersion;
        delete req.body._ClientVersion;
      }
      if (req.body._InstallationId) {
        info.installationId = req.body._InstallationId;
        delete req.body._InstallationId;
      }
      if (req.body._SessionToken) {
        info.sessionToken = req.body._SessionToken;
        delete req.body._SessionToken;
      }
      if (req.body._MasterKey) {
        info.masterKey = req.body._MasterKey;
        delete req.body._MasterKey;
      }
      if (req.body._ContentType) {
        req.headers['content-type'] = req.body._ContentType;
        delete req.body._ContentType;
      }
    } else {
      console.log('middlewares.js L. 97');
      return invalidRequest(req, res);
    }
  }

  if (info.clientVersion) {
    info.clientSDK = ClientSDK.fromString(info.clientVersion);
  }

  if (fileViaJSON) {
    // We need to repopulate req.body with a buffer
    var base64 = req.body.base64;
    req.body = Buffer.from(base64, 'base64');
  }

  const clientIp = getClientIp(req);

  info.app = AppCache.get(info.appId);
  req.config = Config.get(info.appId, mount);
  req.config.headers = req.headers || {};
  req.config.ip = clientIp;
  req.info = info;

  if (
    info.masterKey &&
    req.config.masterKeyIps &&
    req.config.masterKeyIps.length !== 0 &&
    req.config.masterKeyIps.indexOf(clientIp) === -1
  ) {
    console.log('middlewares.js L. 126');
    return invalidRequest(req, res);
  }

  var isMaster = info.masterKey === req.config.masterKey;

  if (isMaster) {
    req.auth = new auth.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: true,
    });
    next();
    return;
  }

  var isReadOnlyMaster = info.masterKey === req.config.readOnlyMasterKey;
  if (
    typeof req.config.readOnlyMasterKey != 'undefined' &&
    req.config.readOnlyMasterKey &&
    isReadOnlyMaster
  ) {
    req.auth = new auth.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: true,
      isReadOnly: true,
    });
    next();
    return;
  }

  // Client keys are not required in parse-server, but if any have been configured in the server, validate them
  //  to preserve original behavior.
  const keys = ['clientKey', 'javascriptKey', 'dotNetKey', 'restAPIKey'];
  const oneKeyConfigured = keys.some(function(key) {
    return req.config[key] !== undefined;
  });
  const oneKeyMatches = keys.some(function(key) {
    return req.config[key] !== undefined && info[key] === req.config[key];
  });

  if (oneKeyConfigured && !oneKeyMatches) {
    console.log('middlewares.js L. 169');
    return invalidRequest(req, res);
  }

  if (req.url == '/login') {
    delete info.sessionToken;
  }

  if (!info.sessionToken) {
    req.auth = new auth.Auth({
      config: req.config,
      installationId: info.installationId,
      isMaster: false,
    });
    next();
    return;
  }

  return Promise.resolve()
    .then(() => {
      // handle the upgradeToRevocableSession path on it's own
      if (
        info.sessionToken &&
        req.url === '/upgradeToRevocableSession' &&
        info.sessionToken.indexOf('r:') != 0
      ) {
        return auth.getAuthForLegacySessionToken({
          config: req.config,
          installationId: info.installationId,
          sessionToken: info.sessionToken,
        });
      } else {
        return auth.getAuthForSessionToken({
          config: req.config,
          installationId: info.installationId,
          sessionToken: info.sessionToken,
        });
      }
    })
    .then(auth => {
      if (auth) {
        req.auth = auth;
        next();
      }
    })
    .catch(error => {
      if (error instanceof Parse.Error) {
        next(error);
        return;
      } else {
        // TODO: Determine the correct error scenario.
        req.config.loggerController.error(
          'error getting auth for sessionToken',
          error
        );
        throw new Parse.Error(Parse.Error.UNKNOWN_ERROR, error);
      }
    });
}

function getClientIp(req) {
  if (req.headers['x-forwarded-for']) {
    // try to get from x-forwared-for if it set (behind reverse proxy)
    return req.headers['x-forwarded-for'].split(',')[0];
  } else if (req.connection && req.connection.remoteAddress) {
    // no proxy, try getting from connection.remoteAddress
    return req.connection.remoteAddress;
  } else if (req.socket) {
    // try to get it from req.socket
    return req.socket.remoteAddress;
  } else if (req.connection && req.connection.socket) {
    // try to get it form the connection.socket
    return req.connection.socket.remoteAddress;
  } else {
    // if non above, fallback.
    return req.ip;
  }
}

function httpAuth(req) {
  if (!(req.req || req).headers.authorization) return;

  var header = (req.req || req).headers.authorization;
  var appId, masterKey, javascriptKey;

  // parse header
  var authPrefix = 'basic ';

  var match = header.toLowerCase().indexOf(authPrefix);

  if (match == 0) {
    var encodedAuth = header.substring(authPrefix.length, header.length);
    var credentials = decodeBase64(encodedAuth).split(':');

    if (credentials.length == 2) {
      appId = credentials[0];
      var key = credentials[1];

      var jsKeyPrefix = 'javascript-key=';

      var matchKey = key.indexOf(jsKeyPrefix);
      if (matchKey == 0) {
        javascriptKey = key.substring(jsKeyPrefix.length, key.length);
      } else {
        masterKey = key;
      }
    }
  }

  return { appId: appId, masterKey: masterKey, javascriptKey: javascriptKey };
}

function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString();
}

export function allowCrossDomain(appId) {
  return (req, res, next) => {
    const config = Config.get(appId, getMountForRequest(req));
    let allowHeaders = DEFAULT_ALLOWED_HEADERS;
    if (config && config.allowHeaders) {
      allowHeaders += `, ${config.allowHeaders.join(', ')}`;
    }
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', allowHeaders);
    res.header(
      'Access-Control-Expose-Headers',
      'X-Parse-Job-Status-Id, X-Parse-Push-Status-Id'
    );
    // intercept OPTIONS method
    if ('OPTIONS' == req.method) {
      res.sendStatus(200);
    } else {
      next();
    }
  };
}

export function allowMethodOverride(req, res, next) {
  if (req.method === 'POST' && req.body._method) {
    req.originalMethod = req.method;
    req.method = req.body._method;
    delete req.body._method;
  }
  next();
}

export function handleParseErrors(err, req, res, next) {
  const log = (req.config && req.config.loggerController) || defaultLogger;
  if (err instanceof Parse.Error) {
    let httpStatus;
    // TODO: fill out this mapping
    switch (err.code) {
      case Parse.Error.INTERNAL_SERVER_ERROR:
        httpStatus = 500;
        break;
      case Parse.Error.OBJECT_NOT_FOUND:
        httpStatus = 404;
        break;
      default:
        httpStatus = 400;
    }

    res.status(httpStatus);
    res.json({ code: err.code, error: err.message });
    log.error('Parse error: ', err);
    if (req.config && req.config.enableExpressErrorHandler) {
      next(err);
    }
  } else if (err.status && err.message) {
    res.status(err.status);
    res.json({ error: err.message });
    next(err);
  } else {
    log.error('Uncaught internal server error.', err, err.stack);
    res.status(500);
    res.json({
      code: Parse.Error.INTERNAL_SERVER_ERROR,
      message: 'Internal server error.',
    });
    next(err);
  }
}

export function enforceMasterKeyAccess(req, res, next) {
  if (!req.auth.isMaster) {
    res.status(403);
    res.end('{"error":"unauthorized: master key is required"}');
    return;
  }
  next();
}

export function promiseEnforceMasterKeyAccess(request) {
  if (!request.auth.isMaster) {
    const error = new Error();
    error.status = 403;
    error.message = 'unauthorized: master key is required';
    throw error;
  }
  return Promise.resolve();
}

function invalidRequest(req, res) {
  res.status(403);
  res.end('{"error":"not authorized"}');
}
