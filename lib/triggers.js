"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.addFunction = addFunction;
exports.addJob = addJob;
exports.addTrigger = addTrigger;
exports.addFileTrigger = addFileTrigger;
exports.addConnectTrigger = addConnectTrigger;
exports.addLiveQueryEventHandler = addLiveQueryEventHandler;
exports.removeFunction = removeFunction;
exports.removeTrigger = removeTrigger;
exports._unregisterAll = _unregisterAll;
exports.getTrigger = getTrigger;
exports.getFileTrigger = getFileTrigger;
exports.triggerExists = triggerExists;
exports.getFunction = getFunction;
exports.getFunctionNames = getFunctionNames;
exports.getJob = getJob;
exports.getJobs = getJobs;
exports.getValidator = getValidator;
exports.getRequestObject = getRequestObject;
exports.getRequestQueryObject = getRequestQueryObject;
exports.getResponseObject = getResponseObject;
exports.maybeRunAfterFindTrigger = maybeRunAfterFindTrigger;
exports.maybeRunQueryTrigger = maybeRunQueryTrigger;
exports.resolveError = resolveError;
exports.maybeRunValidator = maybeRunValidator;
exports.maybeRunTrigger = maybeRunTrigger;
exports.inflate = inflate;
exports.runLiveQueryEventHandlers = runLiveQueryEventHandlers;
exports.getRequestFileObject = getRequestFileObject;
exports.maybeRunFileTrigger = maybeRunFileTrigger;
exports.maybeRunConnectTrigger = maybeRunConnectTrigger;
exports.maybeRunSubscribeTrigger = maybeRunSubscribeTrigger;
exports.maybeRunAfterEventTrigger = maybeRunAfterEventTrigger;
exports.Types = void 0;

var _node = _interopRequireDefault(require("parse/node"));

var _logger = require("./logger");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const Types = {
  beforeLogin: 'beforeLogin',
  afterLogin: 'afterLogin',
  afterLogout: 'afterLogout',
  beforeSave: 'beforeSave',
  afterSave: 'afterSave',
  beforeDelete: 'beforeDelete',
  afterDelete: 'afterDelete',
  beforeFind: 'beforeFind',
  afterFind: 'afterFind',
  beforeSaveFile: 'beforeSaveFile',
  afterSaveFile: 'afterSaveFile',
  beforeDeleteFile: 'beforeDeleteFile',
  afterDeleteFile: 'afterDeleteFile',
  beforeConnect: 'beforeConnect',
  beforeSubscribe: 'beforeSubscribe',
  afterEvent: 'afterEvent'
};
exports.Types = Types;
const FileClassName = '@File';
const ConnectClassName = '@Connect';

const baseStore = function () {
  const Validators = Object.keys(Types).reduce(function (base, key) {
    base[key] = {};
    return base;
  }, {});
  const Functions = {};
  const Jobs = {};
  const LiveQuery = [];
  const Triggers = Object.keys(Types).reduce(function (base, key) {
    base[key] = {};
    return base;
  }, {});
  return Object.freeze({
    Functions,
    Jobs,
    Validators,
    Triggers,
    LiveQuery
  });
};

function validateClassNameForTriggers(className, type) {
  if (type == Types.beforeSave && className === '_PushStatus') {
    // _PushStatus uses undocumented nested key increment ops
    // allowing beforeSave would mess up the objects big time
    // TODO: Allow proper documented way of using nested increment ops
    throw 'Only afterSave is allowed on _PushStatus';
  }

  if ((type === Types.beforeLogin || type === Types.afterLogin) && className !== '_User') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _User class is allowed for the beforeLogin and afterLogin triggers';
  }

  if (type === Types.afterLogout && className !== '_Session') {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the _Session class is allowed for the afterLogout trigger.';
  }

  if (className === '_Session' && type !== Types.afterLogout) {
    // TODO: check if upstream code will handle `Error` instance rather
    // than this anti-pattern of throwing strings
    throw 'Only the afterLogout trigger is allowed for the _Session class.';
  }

  return className;
}

const _triggerStore = {};
const Category = {
  Functions: 'Functions',
  Validators: 'Validators',
  Jobs: 'Jobs',
  Triggers: 'Triggers'
};

function getStore(category, name, applicationId) {
  const path = name.split('.');
  path.splice(-1); // remove last component

  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();
  let store = _triggerStore[applicationId][category];

  for (const component of path) {
    store = store[component];

    if (!store) {
      return undefined;
    }
  }

  return store;
}

function add(category, name, handler, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);

  if (store[lastComponent]) {
    _logger.logger.warn(`Warning: Duplicate cloud functions exist for ${lastComponent}. Only the last one will be used and the others will be ignored.`);
  }

  store[lastComponent] = handler;
}

function remove(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  delete store[lastComponent];
}

function get(category, name, applicationId) {
  const lastComponent = name.split('.').splice(-1);
  const store = getStore(category, name, applicationId);
  return store[lastComponent];
}

function addFunction(functionName, handler, validationHandler, applicationId) {
  add(Category.Functions, functionName, handler, applicationId);
  add(Category.Validators, functionName, validationHandler, applicationId);
}

function addJob(jobName, handler, applicationId) {
  add(Category.Jobs, jobName, handler, applicationId);
}

function addTrigger(type, className, handler, applicationId, validationHandler) {
  validateClassNameForTriggers(className, type);
  add(Category.Triggers, `${type}.${className}`, handler, applicationId);
  add(Category.Validators, `${type}.${className}`, validationHandler, applicationId);
}

function addFileTrigger(type, handler, applicationId, validationHandler) {
  add(Category.Triggers, `${type}.${FileClassName}`, handler, applicationId);
  add(Category.Validators, `${type}.${FileClassName}`, validationHandler, applicationId);
}

function addConnectTrigger(type, handler, applicationId, validationHandler) {
  add(Category.Triggers, `${type}.${ConnectClassName}`, handler, applicationId);
  add(Category.Validators, `${type}.${ConnectClassName}`, validationHandler, applicationId);
}

function addLiveQueryEventHandler(handler, applicationId) {
  applicationId = applicationId || _node.default.applicationId;
  _triggerStore[applicationId] = _triggerStore[applicationId] || baseStore();

  _triggerStore[applicationId].LiveQuery.push(handler);
}

function removeFunction(functionName, applicationId) {
  remove(Category.Functions, functionName, applicationId);
}

function removeTrigger(type, className, applicationId) {
  remove(Category.Triggers, `${type}.${className}`, applicationId);
}

function _unregisterAll() {
  Object.keys(_triggerStore).forEach(appId => delete _triggerStore[appId]);
}

function getTrigger(className, triggerType, applicationId) {
  if (!applicationId) {
    throw 'Missing ApplicationID';
  }

  return get(Category.Triggers, `${triggerType}.${className}`, applicationId);
}

function getFileTrigger(type, applicationId) {
  return getTrigger(FileClassName, type, applicationId);
}

function triggerExists(className, type, applicationId) {
  return getTrigger(className, type, applicationId) != undefined;
}

function getFunction(functionName, applicationId) {
  return get(Category.Functions, functionName, applicationId);
}

function getFunctionNames(applicationId) {
  const store = _triggerStore[applicationId] && _triggerStore[applicationId][Category.Functions] || {};
  const functionNames = [];

  const extractFunctionNames = (namespace, store) => {
    Object.keys(store).forEach(name => {
      const value = store[name];

      if (namespace) {
        name = `${namespace}.${name}`;
      }

      if (typeof value === 'function') {
        functionNames.push(name);
      } else {
        extractFunctionNames(name, value);
      }
    });
  };

  extractFunctionNames(null, store);
  return functionNames;
}

function getJob(jobName, applicationId) {
  return get(Category.Jobs, jobName, applicationId);
}

function getJobs(applicationId) {
  var manager = _triggerStore[applicationId];

  if (manager && manager.Jobs) {
    return manager.Jobs;
  }

  return undefined;
}

function getValidator(functionName, applicationId) {
  return get(Category.Validators, functionName, applicationId);
}

function getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context) {
  const request = {
    triggerName: triggerType,
    object: parseObject,
    master: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip
  };

  if (originalParseObject) {
    request.original = originalParseObject;
  }

  if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete || triggerType === Types.afterFind) {
    // Set a copy of the context on the request object.
    request.context = Object.assign({}, context);
  }

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
  }

  if (auth.user) {
    request['user'] = auth.user;
  }

  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }

  return request;
}

function getRequestQueryObject(triggerType, auth, query, count, config, context, isGet) {
  isGet = !!isGet;
  var request = {
    triggerName: triggerType,
    query,
    master: false,
    count,
    log: config.loggerController,
    isGet,
    headers: config.headers,
    ip: config.ip,
    context: context || {}
  };

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
  }

  if (auth.user) {
    request['user'] = auth.user;
  }

  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }

  return request;
} // Creates the response object, and uses the request object to pass data
// The API will call this with REST API formatted objects, this will
// transform them to Parse.Object instances expected by Cloud Code.
// Any changes made to the object in a beforeSave will be included.


function getResponseObject(request, resolve, reject) {
  return {
    success: function (response) {
      if (request.triggerName === Types.afterFind) {
        if (!response) {
          response = request.objects;
        }

        response = response.map(object => {
          return object.toJSON();
        });
        return resolve(response);
      } // Use the JSON response


      if (response && typeof response === 'object' && !request.object.equals(response) && request.triggerName === Types.beforeSave) {
        return resolve(response);
      }

      if (response && typeof response === 'object' && request.triggerName === Types.afterSave) {
        return resolve(response);
      }

      if (request.triggerName === Types.afterSave) {
        return resolve();
      }

      response = {};

      if (request.triggerName === Types.beforeSave) {
        response['object'] = request.object._getSaveJSON();
      }

      return resolve(response);
    },
    error: function (error) {
      const e = resolveError(error, {
        code: _node.default.Error.SCRIPT_FAILED,
        message: 'Script failed. Unknown error.'
      });
      reject(e);
    }
  };
}

function userIdForLog(auth) {
  return auth && auth.user ? auth.user.id : undefined;
}

function logTriggerAfterHook(triggerType, className, input, auth) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerSuccessBeforeHook(triggerType, className, input, result, auth) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  const cleanResult = _logger.logger.truncateLogMessage(JSON.stringify(result));

  _logger.logger.info(`${triggerType} triggered for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Result: ${cleanResult}`, {
    className,
    triggerType,
    user: userIdForLog(auth)
  });
}

function logTriggerErrorBeforeHook(triggerType, className, input, auth, error) {
  const cleanInput = _logger.logger.truncateLogMessage(JSON.stringify(input));

  _logger.logger.error(`${triggerType} failed for ${className} for user ${userIdForLog(auth)}:\n  Input: ${cleanInput}\n  Error: ${JSON.stringify(error)}`, {
    className,
    triggerType,
    error,
    user: userIdForLog(auth)
  });
}

function maybeRunAfterFindTrigger(triggerType, auth, className, objects, config, query, context) {
  return new Promise((resolve, reject) => {
    const trigger = getTrigger(className, triggerType, config.applicationId);

    if (!trigger) {
      return resolve();
    }

    const request = getRequestObject(triggerType, auth, null, null, config, context);

    if (query) {
      request.query = query;
    }

    const {
      success,
      error
    } = getResponseObject(request, object => {
      resolve(object);
    }, error => {
      reject(error);
    });
    logTriggerSuccessBeforeHook(triggerType, className, 'AfterFind', JSON.stringify(objects), auth);
    request.objects = objects.map(object => {
      //setting the class name to transform into parse object
      object.className = className;
      return _node.default.Object.fromJSON(object);
    });
    return Promise.resolve().then(() => {
      return maybeRunValidator(request, `${triggerType}.${className}`);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return request.objects;
      }

      const response = trigger(request);

      if (response && typeof response.then === 'function') {
        return response.then(results => {
          if (!results) {
            throw new _node.default.Error(_node.default.Error.SCRIPT_FAILED, 'AfterFind expect results to be returned in the promise');
          }

          return results;
        });
      }

      return response;
    }).then(success, error);
  }).then(results => {
    logTriggerAfterHook(triggerType, className, JSON.stringify(results), auth);
    return results;
  });
}

function maybeRunQueryTrigger(triggerType, className, restWhere, restOptions, config, auth, context, isGet) {
  const trigger = getTrigger(className, triggerType, config.applicationId);

  if (!trigger) {
    return Promise.resolve({
      restWhere,
      restOptions
    });
  }

  const json = Object.assign({}, restOptions);
  json.where = restWhere;
  const parseQuery = new _node.default.Query(className);
  parseQuery.withJSON(json);
  let count = false;

  if (restOptions) {
    count = !!restOptions.count;
  }

  const requestObject = getRequestQueryObject(triggerType, auth, parseQuery, count, config, context, isGet);
  return Promise.resolve().then(() => {
    return maybeRunValidator(requestObject, `${triggerType}.${className}`);
  }).then(() => {
    if (requestObject.skipWithMasterKey) {
      return requestObject.query;
    }

    return trigger(requestObject);
  }).then(result => {
    let queryResult = parseQuery;

    if (result && result instanceof _node.default.Query) {
      queryResult = result;
    }

    const jsonQuery = queryResult.toJSON();

    if (jsonQuery.where) {
      restWhere = jsonQuery.where;
    }

    if (jsonQuery.limit) {
      restOptions = restOptions || {};
      restOptions.limit = jsonQuery.limit;
    }

    if (jsonQuery.skip) {
      restOptions = restOptions || {};
      restOptions.skip = jsonQuery.skip;
    }

    if (jsonQuery.include) {
      restOptions = restOptions || {};
      restOptions.include = jsonQuery.include;
    }

    if (jsonQuery.excludeKeys) {
      restOptions = restOptions || {};
      restOptions.excludeKeys = jsonQuery.excludeKeys;
    }

    if (jsonQuery.explain) {
      restOptions = restOptions || {};
      restOptions.explain = jsonQuery.explain;
    }

    if (jsonQuery.keys) {
      restOptions = restOptions || {};
      restOptions.keys = jsonQuery.keys;
    }

    if (jsonQuery.order) {
      restOptions = restOptions || {};
      restOptions.order = jsonQuery.order;
    }

    if (jsonQuery.hint) {
      restOptions = restOptions || {};
      restOptions.hint = jsonQuery.hint;
    }

    if (requestObject.readPreference) {
      restOptions = restOptions || {};
      restOptions.readPreference = requestObject.readPreference;
    }

    if (requestObject.includeReadPreference) {
      restOptions = restOptions || {};
      restOptions.includeReadPreference = requestObject.includeReadPreference;
    }

    if (requestObject.subqueryReadPreference) {
      restOptions = restOptions || {};
      restOptions.subqueryReadPreference = requestObject.subqueryReadPreference;
    }

    return {
      restWhere,
      restOptions
    };
  }, err => {
    const error = resolveError(err, {
      code: _node.default.Error.SCRIPT_FAILED,
      message: 'Script failed. Unknown error.'
    });
    throw error;
  });
}

function resolveError(message, defaultOpts) {
  if (!defaultOpts) {
    defaultOpts = {};
  }

  if (!message) {
    return new _node.default.Error(defaultOpts.code || _node.default.Error.SCRIPT_FAILED, defaultOpts.message || 'Script failed.');
  }

  if (message instanceof _node.default.Error) {
    return message;
  }

  const code = defaultOpts.code || _node.default.Error.SCRIPT_FAILED; // If it's an error, mark it as a script failed

  if (typeof message === 'string') {
    return new _node.default.Error(code, message);
  }

  const error = new _node.default.Error(code, message.message || message);

  if (message instanceof Error) {
    error.stack = message.stack;
  }

  return error;
}

function maybeRunValidator(request, functionName) {
  const theValidator = getValidator(functionName, _node.default.applicationId);

  if (!theValidator) {
    return;
  }

  if (typeof theValidator === 'object' && theValidator.skipWithMasterKey && request.master) {
    request.skipWithMasterKey = true;
  }

  return new Promise((resolve, reject) => {
    return Promise.resolve().then(() => {
      return typeof theValidator === 'object' ? builtInTriggerValidator(theValidator, request) : theValidator(request);
    }).then(() => {
      resolve();
    }).catch(e => {
      const error = resolveError(e, {
        code: _node.default.Error.VALIDATION_ERROR,
        message: 'Validation failed.'
      });
      reject(error);
    });
  });
}

function builtInTriggerValidator(options, request) {
  if (request.master && !options.validateMasterKey) {
    return;
  }

  let reqUser = request.user;

  if (!reqUser && request.object && request.object.className === '_User' && !request.object.existed()) {
    reqUser = request.object;
  }

  if (options.requireUser && !reqUser) {
    throw 'Validation failed. Please login to continue.';
  }

  if (options.requireMaster && !request.master) {
    throw 'Validation failed. Master key is required to complete this request.';
  }

  let params = request.params || {};

  if (request.object) {
    params = request.object.toJSON();
  }

  const requiredParam = key => {
    const value = params[key];

    if (value == null) {
      throw `Validation failed. Please specify data for ${key}.`;
    }
  };

  const validateOptions = (opt, key, val) => {
    let opts = opt.options;

    if (typeof opts === 'function') {
      try {
        const result = opts(val);

        if (!result && result != null) {
          throw opt.error || `Validation failed. Invalid value for ${key}.`;
        }
      } catch (e) {
        if (!e) {
          throw opt.error || `Validation failed. Invalid value for ${key}.`;
        }

        throw opt.error || e.message || e;
      }

      return;
    }

    if (!Array.isArray(opts)) {
      opts = [opt.options];
    }

    if (!opts.includes(val)) {
      throw opt.error || `Validation failed. Invalid option for ${key}. Expected: ${opts.join(', ')}`;
    }
  };

  const getType = fn => {
    const match = fn && fn.toString().match(/^\s*function (\w+)/);
    return (match ? match[1] : '').toLowerCase();
  };

  if (Array.isArray(options.fields)) {
    for (const key of options.fields) {
      requiredParam(key);
    }
  } else {
    for (const key in options.fields) {
      const opt = options.fields[key];
      let val = params[key];

      if (typeof opt === 'string') {
        requiredParam(opt);
      }

      if (typeof opt === 'object') {
        if (opt.default != null && val == null) {
          val = opt.default;
          params[key] = val;

          if (request.object) {
            request.object.set(key, val);
          }
        }

        if (opt.constant && request.object) {
          if (request.original) {
            request.object.set(key, request.original.get(key));
          } else if (opt.default != null) {
            request.object.set(key, opt.default);
          }
        }

        if (opt.required) {
          requiredParam(key);
        }

        if (opt.type) {
          const type = getType(opt.type);

          if (type == 'array' && !Array.isArray(val)) {
            throw `Validation failed. Invalid type for ${key}. Expected: array`;
          } else if (typeof val !== type) {
            throw `Validation failed. Invalid type for ${key}. Expected: ${type}`;
          }
        }

        if (opt.options) {
          validateOptions(opt, key, val);
        }
      }
    }
  }

  const userKeys = options.requireUserKeys || [];

  if (Array.isArray(userKeys)) {
    for (const key of userKeys) {
      if (!reqUser) {
        throw 'Please login to make this request.';
      }

      if (reqUser.get(key) == null) {
        throw `Validation failed. Please set data for ${key} on your account.`;
      }
    }
  } else if (typeof userKeys === 'object') {
    for (const key in options.requireUserKeys) {
      const opt = options.requireUserKeys[key];

      if (opt.options) {
        validateOptions(opt, key, reqUser.get(key));
      }
    }
  }
} // To be used as part of the promise chain when saving/deleting an object
// Will resolve successfully if no trigger is configured
// Resolves to an object, empty or containing an object key. A beforeSave
// trigger will set the object key to the rest format object to save.
// originalParseObject is optional, we only need that for before/afterSave functions


function maybeRunTrigger(triggerType, auth, parseObject, originalParseObject, config, context) {
  if (!parseObject) {
    return Promise.resolve({});
  }

  return new Promise(function (resolve, reject) {
    var trigger = getTrigger(parseObject.className, triggerType, config.applicationId);
    if (!trigger) return resolve();
    var request = getRequestObject(triggerType, auth, parseObject, originalParseObject, config, context);
    var {
      success,
      error
    } = getResponseObject(request, object => {
      logTriggerSuccessBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), object, auth);

      if (triggerType === Types.beforeSave || triggerType === Types.afterSave || triggerType === Types.beforeDelete || triggerType === Types.afterDelete) {
        Object.assign(context, request.context);
      }

      resolve(object);
    }, error => {
      logTriggerErrorBeforeHook(triggerType, parseObject.className, parseObject.toJSON(), auth, error);
      reject(error);
    }); // AfterSave and afterDelete triggers can return a promise, which if they
    // do, needs to be resolved before this promise is resolved,
    // so trigger execution is synced with RestWrite.execute() call.
    // If triggers do not return a promise, they can run async code parallel
    // to the RestWrite.execute() call.

    return Promise.resolve().then(() => {
      return maybeRunValidator(request, `${triggerType}.${parseObject.className}`);
    }).then(() => {
      if (request.skipWithMasterKey) {
        return Promise.resolve();
      }

      const promise = trigger(request);

      if (triggerType === Types.afterSave || triggerType === Types.afterDelete || triggerType === Types.afterLogin) {
        logTriggerAfterHook(triggerType, parseObject.className, parseObject.toJSON(), auth);
      } // beforeSave is expected to return null (nothing)


      if (triggerType === Types.beforeSave) {
        if (promise && typeof promise.then === 'function') {
          return promise.then(response => {
            // response.object may come from express routing before hook
            if (response && response.object) {
              return response;
            }

            return null;
          });
        }

        return null;
      }

      return promise;
    }).then(success, error);
  });
} // Converts a REST-format object to a Parse.Object
// data is either className or an object


function inflate(data, restObject) {
  var copy = typeof data == 'object' ? data : {
    className: data
  };

  for (var key in restObject) {
    copy[key] = restObject[key];
  }

  return _node.default.Object.fromJSON(copy);
}

function runLiveQueryEventHandlers(data, applicationId = _node.default.applicationId) {
  if (!_triggerStore || !_triggerStore[applicationId] || !_triggerStore[applicationId].LiveQuery) {
    return;
  }

  _triggerStore[applicationId].LiveQuery.forEach(handler => handler(data));
}

function getRequestFileObject(triggerType, auth, fileObject, config) {
  const request = _objectSpread({}, fileObject, {
    triggerName: triggerType,
    master: false,
    log: config.loggerController,
    headers: config.headers,
    ip: config.ip
  });

  if (!auth) {
    return request;
  }

  if (auth.isMaster) {
    request['master'] = true;
  }

  if (auth.user) {
    request['user'] = auth.user;
  }

  if (auth.installationId) {
    request['installationId'] = auth.installationId;
  }

  return request;
}

async function maybeRunFileTrigger(triggerType, fileObject, config, auth) {
  const fileTrigger = getFileTrigger(triggerType, config.applicationId);

  if (typeof fileTrigger === 'function') {
    try {
      const request = getRequestFileObject(triggerType, auth, fileObject, config);
      await maybeRunValidator(request, `${triggerType}.${FileClassName}`);

      if (request.skipWithMasterKey) {
        return fileObject;
      }

      const result = await fileTrigger(request);
      logTriggerSuccessBeforeHook(triggerType, 'Parse.File', _objectSpread({}, fileObject.file.toJSON(), {
        fileSize: fileObject.fileSize
      }), result, auth);
      return result || fileObject;
    } catch (error) {
      logTriggerErrorBeforeHook(triggerType, 'Parse.File', _objectSpread({}, fileObject.file.toJSON(), {
        fileSize: fileObject.fileSize
      }), auth, error);
      throw error;
    }
  }

  return fileObject;
}

async function maybeRunConnectTrigger(triggerType, request) {
  const trigger = getTrigger(ConnectClassName, triggerType, _node.default.applicationId);

  if (!trigger) {
    return;
  }

  request.user = await userForSessionToken(request.sessionToken);
  await maybeRunValidator(request, `${triggerType}.${ConnectClassName}`);

  if (request.skipWithMasterKey) {
    return;
  }

  return trigger(request);
}

async function maybeRunSubscribeTrigger(triggerType, className, request) {
  const trigger = getTrigger(className, triggerType, _node.default.applicationId);

  if (!trigger) {
    return;
  }

  const parseQuery = new _node.default.Query(className);
  parseQuery.withJSON(request.query);
  request.query = parseQuery;
  request.user = await userForSessionToken(request.sessionToken);
  await maybeRunValidator(request, `${triggerType}.${className}`);

  if (request.skipWithMasterKey) {
    return;
  }

  await trigger(request);
  const query = request.query.toJSON();

  if (query.keys) {
    query.fields = query.keys.split(',');
  }

  request.query = query;
}

async function maybeRunAfterEventTrigger(triggerType, className, request) {
  const trigger = getTrigger(className, triggerType, _node.default.applicationId);

  if (!trigger) {
    return;
  }

  if (request.object) {
    request.object = _node.default.Object.fromJSON(request.object);
  }

  if (request.original) {
    request.original = _node.default.Object.fromJSON(request.original);
  }

  request.user = await userForSessionToken(request.sessionToken);
  await maybeRunValidator(request, `${triggerType}.${className}`);

  if (request.skipWithMasterKey) {
    return;
  }

  return trigger(request);
}

async function userForSessionToken(sessionToken) {
  if (!sessionToken) {
    return;
  }

  const q = new _node.default.Query('_Session');
  q.equalTo('sessionToken', sessionToken);
  q.include('user');
  const session = await q.first({
    useMasterKey: true
  });

  if (!session) {
    return;
  }

  return session.get('user');
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy90cmlnZ2Vycy5qcyJdLCJuYW1lcyI6WyJUeXBlcyIsImJlZm9yZUxvZ2luIiwiYWZ0ZXJMb2dpbiIsImFmdGVyTG9nb3V0IiwiYmVmb3JlU2F2ZSIsImFmdGVyU2F2ZSIsImJlZm9yZURlbGV0ZSIsImFmdGVyRGVsZXRlIiwiYmVmb3JlRmluZCIsImFmdGVyRmluZCIsImJlZm9yZVNhdmVGaWxlIiwiYWZ0ZXJTYXZlRmlsZSIsImJlZm9yZURlbGV0ZUZpbGUiLCJhZnRlckRlbGV0ZUZpbGUiLCJiZWZvcmVDb25uZWN0IiwiYmVmb3JlU3Vic2NyaWJlIiwiYWZ0ZXJFdmVudCIsIkZpbGVDbGFzc05hbWUiLCJDb25uZWN0Q2xhc3NOYW1lIiwiYmFzZVN0b3JlIiwiVmFsaWRhdG9ycyIsIk9iamVjdCIsImtleXMiLCJyZWR1Y2UiLCJiYXNlIiwia2V5IiwiRnVuY3Rpb25zIiwiSm9icyIsIkxpdmVRdWVyeSIsIlRyaWdnZXJzIiwiZnJlZXplIiwidmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyIsImNsYXNzTmFtZSIsInR5cGUiLCJfdHJpZ2dlclN0b3JlIiwiQ2F0ZWdvcnkiLCJnZXRTdG9yZSIsImNhdGVnb3J5IiwibmFtZSIsImFwcGxpY2F0aW9uSWQiLCJwYXRoIiwic3BsaXQiLCJzcGxpY2UiLCJQYXJzZSIsInN0b3JlIiwiY29tcG9uZW50IiwidW5kZWZpbmVkIiwiYWRkIiwiaGFuZGxlciIsImxhc3RDb21wb25lbnQiLCJsb2dnZXIiLCJ3YXJuIiwicmVtb3ZlIiwiZ2V0IiwiYWRkRnVuY3Rpb24iLCJmdW5jdGlvbk5hbWUiLCJ2YWxpZGF0aW9uSGFuZGxlciIsImFkZEpvYiIsImpvYk5hbWUiLCJhZGRUcmlnZ2VyIiwiYWRkRmlsZVRyaWdnZXIiLCJhZGRDb25uZWN0VHJpZ2dlciIsImFkZExpdmVRdWVyeUV2ZW50SGFuZGxlciIsInB1c2giLCJyZW1vdmVGdW5jdGlvbiIsInJlbW92ZVRyaWdnZXIiLCJfdW5yZWdpc3RlckFsbCIsImZvckVhY2giLCJhcHBJZCIsImdldFRyaWdnZXIiLCJ0cmlnZ2VyVHlwZSIsImdldEZpbGVUcmlnZ2VyIiwidHJpZ2dlckV4aXN0cyIsImdldEZ1bmN0aW9uIiwiZ2V0RnVuY3Rpb25OYW1lcyIsImZ1bmN0aW9uTmFtZXMiLCJleHRyYWN0RnVuY3Rpb25OYW1lcyIsIm5hbWVzcGFjZSIsInZhbHVlIiwiZ2V0Sm9iIiwiZ2V0Sm9icyIsIm1hbmFnZXIiLCJnZXRWYWxpZGF0b3IiLCJnZXRSZXF1ZXN0T2JqZWN0IiwiYXV0aCIsInBhcnNlT2JqZWN0Iiwib3JpZ2luYWxQYXJzZU9iamVjdCIsImNvbmZpZyIsImNvbnRleHQiLCJyZXF1ZXN0IiwidHJpZ2dlck5hbWUiLCJvYmplY3QiLCJtYXN0ZXIiLCJsb2ciLCJsb2dnZXJDb250cm9sbGVyIiwiaGVhZGVycyIsImlwIiwib3JpZ2luYWwiLCJhc3NpZ24iLCJpc01hc3RlciIsInVzZXIiLCJpbnN0YWxsYXRpb25JZCIsImdldFJlcXVlc3RRdWVyeU9iamVjdCIsInF1ZXJ5IiwiY291bnQiLCJpc0dldCIsImdldFJlc3BvbnNlT2JqZWN0IiwicmVzb2x2ZSIsInJlamVjdCIsInN1Y2Nlc3MiLCJyZXNwb25zZSIsIm9iamVjdHMiLCJtYXAiLCJ0b0pTT04iLCJlcXVhbHMiLCJfZ2V0U2F2ZUpTT04iLCJlcnJvciIsImUiLCJyZXNvbHZlRXJyb3IiLCJjb2RlIiwiRXJyb3IiLCJTQ1JJUFRfRkFJTEVEIiwibWVzc2FnZSIsInVzZXJJZEZvckxvZyIsImlkIiwibG9nVHJpZ2dlckFmdGVySG9vayIsImlucHV0IiwiY2xlYW5JbnB1dCIsInRydW5jYXRlTG9nTWVzc2FnZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJpbmZvIiwibG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rIiwicmVzdWx0IiwiY2xlYW5SZXN1bHQiLCJsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rIiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwiUHJvbWlzZSIsInRyaWdnZXIiLCJmcm9tSlNPTiIsInRoZW4iLCJtYXliZVJ1blZhbGlkYXRvciIsInNraXBXaXRoTWFzdGVyS2V5IiwicmVzdWx0cyIsIm1heWJlUnVuUXVlcnlUcmlnZ2VyIiwicmVzdFdoZXJlIiwicmVzdE9wdGlvbnMiLCJqc29uIiwid2hlcmUiLCJwYXJzZVF1ZXJ5IiwiUXVlcnkiLCJ3aXRoSlNPTiIsInJlcXVlc3RPYmplY3QiLCJxdWVyeVJlc3VsdCIsImpzb25RdWVyeSIsImxpbWl0Iiwic2tpcCIsImluY2x1ZGUiLCJleGNsdWRlS2V5cyIsImV4cGxhaW4iLCJvcmRlciIsImhpbnQiLCJyZWFkUHJlZmVyZW5jZSIsImluY2x1ZGVSZWFkUHJlZmVyZW5jZSIsInN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UiLCJlcnIiLCJkZWZhdWx0T3B0cyIsInN0YWNrIiwidGhlVmFsaWRhdG9yIiwiYnVpbHRJblRyaWdnZXJWYWxpZGF0b3IiLCJjYXRjaCIsIlZBTElEQVRJT05fRVJST1IiLCJvcHRpb25zIiwidmFsaWRhdGVNYXN0ZXJLZXkiLCJyZXFVc2VyIiwiZXhpc3RlZCIsInJlcXVpcmVVc2VyIiwicmVxdWlyZU1hc3RlciIsInBhcmFtcyIsInJlcXVpcmVkUGFyYW0iLCJ2YWxpZGF0ZU9wdGlvbnMiLCJvcHQiLCJ2YWwiLCJvcHRzIiwiQXJyYXkiLCJpc0FycmF5IiwiaW5jbHVkZXMiLCJqb2luIiwiZ2V0VHlwZSIsImZuIiwibWF0Y2giLCJ0b1N0cmluZyIsInRvTG93ZXJDYXNlIiwiZmllbGRzIiwiZGVmYXVsdCIsInNldCIsImNvbnN0YW50IiwicmVxdWlyZWQiLCJ1c2VyS2V5cyIsInJlcXVpcmVVc2VyS2V5cyIsIm1heWJlUnVuVHJpZ2dlciIsInByb21pc2UiLCJpbmZsYXRlIiwiZGF0YSIsInJlc3RPYmplY3QiLCJjb3B5IiwicnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyIsImdldFJlcXVlc3RGaWxlT2JqZWN0IiwiZmlsZU9iamVjdCIsIm1heWJlUnVuRmlsZVRyaWdnZXIiLCJmaWxlVHJpZ2dlciIsImZpbGUiLCJmaWxlU2l6ZSIsIm1heWJlUnVuQ29ubmVjdFRyaWdnZXIiLCJ1c2VyRm9yU2Vzc2lvblRva2VuIiwic2Vzc2lvblRva2VuIiwibWF5YmVSdW5TdWJzY3JpYmVUcmlnZ2VyIiwibWF5YmVSdW5BZnRlckV2ZW50VHJpZ2dlciIsInEiLCJlcXVhbFRvIiwic2Vzc2lvbiIsImZpcnN0IiwidXNlTWFzdGVyS2V5Il0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFDQTs7QUFDQTs7Ozs7Ozs7OztBQUVPLE1BQU1BLEtBQUssR0FBRztBQUNuQkMsRUFBQUEsV0FBVyxFQUFFLGFBRE07QUFFbkJDLEVBQUFBLFVBQVUsRUFBRSxZQUZPO0FBR25CQyxFQUFBQSxXQUFXLEVBQUUsYUFITTtBQUluQkMsRUFBQUEsVUFBVSxFQUFFLFlBSk87QUFLbkJDLEVBQUFBLFNBQVMsRUFBRSxXQUxRO0FBTW5CQyxFQUFBQSxZQUFZLEVBQUUsY0FOSztBQU9uQkMsRUFBQUEsV0FBVyxFQUFFLGFBUE07QUFRbkJDLEVBQUFBLFVBQVUsRUFBRSxZQVJPO0FBU25CQyxFQUFBQSxTQUFTLEVBQUUsV0FUUTtBQVVuQkMsRUFBQUEsY0FBYyxFQUFFLGdCQVZHO0FBV25CQyxFQUFBQSxhQUFhLEVBQUUsZUFYSTtBQVluQkMsRUFBQUEsZ0JBQWdCLEVBQUUsa0JBWkM7QUFhbkJDLEVBQUFBLGVBQWUsRUFBRSxpQkFiRTtBQWNuQkMsRUFBQUEsYUFBYSxFQUFFLGVBZEk7QUFlbkJDLEVBQUFBLGVBQWUsRUFBRSxpQkFmRTtBQWdCbkJDLEVBQUFBLFVBQVUsRUFBRTtBQWhCTyxDQUFkOztBQW1CUCxNQUFNQyxhQUFhLEdBQUcsT0FBdEI7QUFDQSxNQUFNQyxnQkFBZ0IsR0FBRyxVQUF6Qjs7QUFFQSxNQUFNQyxTQUFTLEdBQUcsWUFBWTtBQUM1QixRQUFNQyxVQUFVLEdBQUdDLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZdEIsS0FBWixFQUFtQnVCLE1BQW5CLENBQTBCLFVBQVVDLElBQVYsRUFB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Z2dlcnMuanNcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gJy4vbG9nZ2VyJztcblxuZXhwb3J0IGNvbnN0IFR5cGVzID0ge1xuICBiZWZvcmVMb2dpbjogJ2JlZm9yZUxvZ2luJyxcbiAgYWZ0ZXJMb2dpbjogJ2FmdGVyTG9naW4nLFxuICBhZnRlckxvZ291dDogJ2FmdGVyTG9nb3V0JyxcbiAgYmVmb3JlU2F2ZTogJ2JlZm9yZVNhdmUnLFxuICBhZnRlclNhdmU6ICdhZnRlclNhdmUnLFxuICBiZWZvcmVEZWxldGU6ICdiZWZvcmVEZWxldGUnLFxuICBhZnRlckRlbGV0ZTogJ2FmdGVyRGVsZXRlJyxcbiAgYmVmb3JlRmluZDogJ2JlZm9yZUZpbmQnLFxuICBhZnRlckZpbmQ6ICdhZnRlckZpbmQnLFxuICBiZWZvcmVTYXZlRmlsZTogJ2JlZm9yZVNhdmVGaWxlJyxcbiAgYWZ0ZXJTYXZlRmlsZTogJ2FmdGVyU2F2ZUZpbGUnLFxuICBiZWZvcmVEZWxldGVGaWxlOiAnYmVmb3JlRGVsZXRlRmlsZScsXG4gIGFmdGVyRGVsZXRlRmlsZTogJ2FmdGVyRGVsZXRlRmlsZScsXG4gIGJlZm9yZUNvbm5lY3Q6ICdiZWZvcmVDb25uZWN0JyxcbiAgYmVmb3JlU3Vic2NyaWJlOiAnYmVmb3JlU3Vic2NyaWJlJyxcbiAgYWZ0ZXJFdmVudDogJ2FmdGVyRXZlbnQnLFxufTtcblxuY29uc3QgRmlsZUNsYXNzTmFtZSA9ICdARmlsZSc7XG5jb25zdCBDb25uZWN0Q2xhc3NOYW1lID0gJ0BDb25uZWN0JztcblxuY29uc3QgYmFzZVN0b3JlID0gZnVuY3Rpb24gKCkge1xuICBjb25zdCBWYWxpZGF0b3JzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbiAoYmFzZSwga2V5KSB7XG4gICAgYmFzZVtrZXldID0ge307XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sIHt9KTtcbiAgY29uc3QgRnVuY3Rpb25zID0ge307XG4gIGNvbnN0IEpvYnMgPSB7fTtcbiAgY29uc3QgTGl2ZVF1ZXJ5ID0gW107XG4gIGNvbnN0IFRyaWdnZXJzID0gT2JqZWN0LmtleXMoVHlwZXMpLnJlZHVjZShmdW5jdGlvbiAoYmFzZSwga2V5KSB7XG4gICAgYmFzZVtrZXldID0ge307XG4gICAgcmV0dXJuIGJhc2U7XG4gIH0sIHt9KTtcblxuICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7XG4gICAgRnVuY3Rpb25zLFxuICAgIEpvYnMsXG4gICAgVmFsaWRhdG9ycyxcbiAgICBUcmlnZ2VycyxcbiAgICBMaXZlUXVlcnksXG4gIH0pO1xufTtcblxuZnVuY3Rpb24gdmFsaWRhdGVDbGFzc05hbWVGb3JUcmlnZ2VycyhjbGFzc05hbWUsIHR5cGUpIHtcbiAgaWYgKHR5cGUgPT0gVHlwZXMuYmVmb3JlU2F2ZSAmJiBjbGFzc05hbWUgPT09ICdfUHVzaFN0YXR1cycpIHtcbiAgICAvLyBfUHVzaFN0YXR1cyB1c2VzIHVuZG9jdW1lbnRlZCBuZXN0ZWQga2V5IGluY3JlbWVudCBvcHNcbiAgICAvLyBhbGxvd2luZyBiZWZvcmVTYXZlIHdvdWxkIG1lc3MgdXAgdGhlIG9iamVjdHMgYmlnIHRpbWVcbiAgICAvLyBUT0RPOiBBbGxvdyBwcm9wZXIgZG9jdW1lbnRlZCB3YXkgb2YgdXNpbmcgbmVzdGVkIGluY3JlbWVudCBvcHNcbiAgICB0aHJvdyAnT25seSBhZnRlclNhdmUgaXMgYWxsb3dlZCBvbiBfUHVzaFN0YXR1cyc7XG4gIH1cbiAgaWYgKCh0eXBlID09PSBUeXBlcy5iZWZvcmVMb2dpbiB8fCB0eXBlID09PSBUeXBlcy5hZnRlckxvZ2luKSAmJiBjbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICAvLyBUT0RPOiBjaGVjayBpZiB1cHN0cmVhbSBjb2RlIHdpbGwgaGFuZGxlIGBFcnJvcmAgaW5zdGFuY2UgcmF0aGVyXG4gICAgLy8gdGhhbiB0aGlzIGFudGktcGF0dGVybiBvZiB0aHJvd2luZyBzdHJpbmdzXG4gICAgdGhyb3cgJ09ubHkgdGhlIF9Vc2VyIGNsYXNzIGlzIGFsbG93ZWQgZm9yIHRoZSBiZWZvcmVMb2dpbiBhbmQgYWZ0ZXJMb2dpbiB0cmlnZ2Vycyc7XG4gIH1cbiAgaWYgKHR5cGUgPT09IFR5cGVzLmFmdGVyTG9nb3V0ICYmIGNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIC8vIFRPRE86IGNoZWNrIGlmIHVwc3RyZWFtIGNvZGUgd2lsbCBoYW5kbGUgYEVycm9yYCBpbnN0YW5jZSByYXRoZXJcbiAgICAvLyB0aGFuIHRoaXMgYW50aS1wYXR0ZXJuIG9mIHRocm93aW5nIHN0cmluZ3NcbiAgICB0aHJvdyAnT25seSB0aGUgX1Nlc3Npb24gY2xhc3MgaXMgYWxsb3dlZCBmb3IgdGhlIGFmdGVyTG9nb3V0IHRyaWdnZXIuJztcbiAgfVxuICBpZiAoY2xhc3NOYW1lID09PSAnX1Nlc3Npb24nICYmIHR5cGUgIT09IFR5cGVzLmFmdGVyTG9nb3V0KSB7XG4gICAgLy8gVE9ETzogY2hlY2sgaWYgdXBzdHJlYW0gY29kZSB3aWxsIGhhbmRsZSBgRXJyb3JgIGluc3RhbmNlIHJhdGhlclxuICAgIC8vIHRoYW4gdGhpcyBhbnRpLXBhdHRlcm4gb2YgdGhyb3dpbmcgc3RyaW5nc1xuICAgIHRocm93ICdPbmx5IHRoZSBhZnRlckxvZ291dCB0cmlnZ2VyIGlzIGFsbG93ZWQgZm9yIHRoZSBfU2Vzc2lvbiBjbGFzcy4nO1xuICB9XG4gIHJldHVybiBjbGFzc05hbWU7XG59XG5cbmNvbnN0IF90cmlnZ2VyU3RvcmUgPSB7fTtcblxuY29uc3QgQ2F0ZWdvcnkgPSB7XG4gIEZ1bmN0aW9uczogJ0Z1bmN0aW9ucycsXG4gIFZhbGlkYXRvcnM6ICdWYWxpZGF0b3JzJyxcbiAgSm9iczogJ0pvYnMnLFxuICBUcmlnZ2VyczogJ1RyaWdnZXJzJyxcbn07XG5cbmZ1bmN0aW9uIGdldFN0b3JlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IHBhdGggPSBuYW1lLnNwbGl0KCcuJyk7XG4gIHBhdGguc3BsaWNlKC0xKTsgLy8gcmVtb3ZlIGxhc3QgY29tcG9uZW50XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBsZXQgc3RvcmUgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdW2NhdGVnb3J5XTtcbiAgZm9yIChjb25zdCBjb21wb25lbnQgb2YgcGF0aCkge1xuICAgIHN0b3JlID0gc3RvcmVbY29tcG9uZW50XTtcbiAgICBpZiAoIXN0b3JlKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgfVxuICByZXR1cm4gc3RvcmU7XG59XG5cbmZ1bmN0aW9uIGFkZChjYXRlZ29yeSwgbmFtZSwgaGFuZGxlciwgYXBwbGljYXRpb25JZCkge1xuICBjb25zdCBsYXN0Q29tcG9uZW50ID0gbmFtZS5zcGxpdCgnLicpLnNwbGljZSgtMSk7XG4gIGNvbnN0IHN0b3JlID0gZ2V0U3RvcmUoY2F0ZWdvcnksIG5hbWUsIGFwcGxpY2F0aW9uSWQpO1xuICBpZiAoc3RvcmVbbGFzdENvbXBvbmVudF0pIHtcbiAgICBsb2dnZXIud2FybihcbiAgICAgIGBXYXJuaW5nOiBEdXBsaWNhdGUgY2xvdWQgZnVuY3Rpb25zIGV4aXN0IGZvciAke2xhc3RDb21wb25lbnR9LiBPbmx5IHRoZSBsYXN0IG9uZSB3aWxsIGJlIHVzZWQgYW5kIHRoZSBvdGhlcnMgd2lsbCBiZSBpZ25vcmVkLmBcbiAgICApO1xuICB9XG4gIHN0b3JlW2xhc3RDb21wb25lbnRdID0gaGFuZGxlcjtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlKGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIGRlbGV0ZSBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZnVuY3Rpb24gZ2V0KGNhdGVnb3J5LCBuYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIGNvbnN0IGxhc3RDb21wb25lbnQgPSBuYW1lLnNwbGl0KCcuJykuc3BsaWNlKC0xKTtcbiAgY29uc3Qgc3RvcmUgPSBnZXRTdG9yZShjYXRlZ29yeSwgbmFtZSwgYXBwbGljYXRpb25JZCk7XG4gIHJldHVybiBzdG9yZVtsYXN0Q29tcG9uZW50XTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEZ1bmN0aW9uKGZ1bmN0aW9uTmFtZSwgaGFuZGxlciwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkZ1bmN0aW9ucywgZnVuY3Rpb25OYW1lLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGZ1bmN0aW9uTmFtZSwgdmFsaWRhdGlvbkhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkSm9iKGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpIHtcbiAgYWRkKENhdGVnb3J5LkpvYnMsIGpvYk5hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYWRkVHJpZ2dlcih0eXBlLCBjbGFzc05hbWUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIHZhbGlkYXRlQ2xhc3NOYW1lRm9yVHJpZ2dlcnMoY2xhc3NOYW1lLCB0eXBlKTtcbiAgYWRkKENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0eXBlfS4ke2NsYXNzTmFtZX1gLCBoYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbiAgYWRkKENhdGVnb3J5LlZhbGlkYXRvcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZEZpbGVUcmlnZ2VyKHR5cGUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIGFkZChDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtGaWxlQ2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtGaWxlQ2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZENvbm5lY3RUcmlnZ2VyKHR5cGUsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQsIHZhbGlkYXRpb25IYW5kbGVyKSB7XG4gIGFkZChDYXRlZ29yeS5UcmlnZ2VycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIGhhbmRsZXIsIGFwcGxpY2F0aW9uSWQpO1xuICBhZGQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgYCR7dHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWAsIHZhbGlkYXRpb25IYW5kbGVyLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGFkZExpdmVRdWVyeUV2ZW50SGFuZGxlcihoYW5kbGVyLCBhcHBsaWNhdGlvbklkKSB7XG4gIGFwcGxpY2F0aW9uSWQgPSBhcHBsaWNhdGlvbklkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdIHx8IGJhc2VTdG9yZSgpO1xuICBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdLkxpdmVRdWVyeS5wdXNoKGhhbmRsZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRnVuY3Rpb24oZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJlbW92ZShDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVUcmlnZ2VyKHR5cGUsIGNsYXNzTmFtZSwgYXBwbGljYXRpb25JZCkge1xuICByZW1vdmUoQ2F0ZWdvcnkuVHJpZ2dlcnMsIGAke3R5cGV9LiR7Y2xhc3NOYW1lfWAsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3VucmVnaXN0ZXJBbGwoKSB7XG4gIE9iamVjdC5rZXlzKF90cmlnZ2VyU3RvcmUpLmZvckVhY2goYXBwSWQgPT4gZGVsZXRlIF90cmlnZ2VyU3RvcmVbYXBwSWRdKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgYXBwbGljYXRpb25JZCkge1xuICBpZiAoIWFwcGxpY2F0aW9uSWQpIHtcbiAgICB0aHJvdyAnTWlzc2luZyBBcHBsaWNhdGlvbklEJztcbiAgfVxuICByZXR1cm4gZ2V0KENhdGVnb3J5LlRyaWdnZXJzLCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGaWxlVHJpZ2dlcih0eXBlLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXRUcmlnZ2VyKEZpbGVDbGFzc05hbWUsIHR5cGUsIGFwcGxpY2F0aW9uSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHJpZ2dlckV4aXN0cyhjbGFzc05hbWU6IHN0cmluZywgdHlwZTogc3RyaW5nLCBhcHBsaWNhdGlvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0eXBlLCBhcHBsaWNhdGlvbklkKSAhPSB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbihmdW5jdGlvbk5hbWUsIGFwcGxpY2F0aW9uSWQpIHtcbiAgcmV0dXJuIGdldChDYXRlZ29yeS5GdW5jdGlvbnMsIGZ1bmN0aW9uTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdW5jdGlvbk5hbWVzKGFwcGxpY2F0aW9uSWQpIHtcbiAgY29uc3Qgc3RvcmUgPVxuICAgIChfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdICYmIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF1bQ2F0ZWdvcnkuRnVuY3Rpb25zXSkgfHwge307XG4gIGNvbnN0IGZ1bmN0aW9uTmFtZXMgPSBbXTtcbiAgY29uc3QgZXh0cmFjdEZ1bmN0aW9uTmFtZXMgPSAobmFtZXNwYWNlLCBzdG9yZSkgPT4ge1xuICAgIE9iamVjdC5rZXlzKHN0b3JlKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzdG9yZVtuYW1lXTtcbiAgICAgIGlmIChuYW1lc3BhY2UpIHtcbiAgICAgICAgbmFtZSA9IGAke25hbWVzcGFjZX0uJHtuYW1lfWA7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZXMucHVzaChuYW1lKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGV4dHJhY3RGdW5jdGlvbk5hbWVzKG5hbWUsIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcbiAgZXh0cmFjdEZ1bmN0aW9uTmFtZXMobnVsbCwgc3RvcmUpO1xuICByZXR1cm4gZnVuY3Rpb25OYW1lcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEpvYihqb2JOYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuSm9icywgam9iTmFtZSwgYXBwbGljYXRpb25JZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRKb2JzKGFwcGxpY2F0aW9uSWQpIHtcbiAgdmFyIG1hbmFnZXIgPSBfdHJpZ2dlclN0b3JlW2FwcGxpY2F0aW9uSWRdO1xuICBpZiAobWFuYWdlciAmJiBtYW5hZ2VyLkpvYnMpIHtcbiAgICByZXR1cm4gbWFuYWdlci5Kb2JzO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRWYWxpZGF0b3IoZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKSB7XG4gIHJldHVybiBnZXQoQ2F0ZWdvcnkuVmFsaWRhdG9ycywgZnVuY3Rpb25OYW1lLCBhcHBsaWNhdGlvbklkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RPYmplY3QoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0XG4pIHtcbiAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgb2JqZWN0OiBwYXJzZU9iamVjdCxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgfTtcblxuICBpZiAob3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgIHJlcXVlc3Qub3JpZ2luYWwgPSBvcmlnaW5hbFBhcnNlT2JqZWN0O1xuICB9XG4gIGlmIChcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlU2F2ZSB8fFxuICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5hZnRlclNhdmUgfHxcbiAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYmVmb3JlRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlIHx8XG4gICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRmluZFxuICApIHtcbiAgICAvLyBTZXQgYSBjb3B5IG9mIHRoZSBjb250ZXh0IG9uIHRoZSByZXF1ZXN0IG9iamVjdC5cbiAgICByZXF1ZXN0LmNvbnRleHQgPSBPYmplY3QuYXNzaWduKHt9LCBjb250ZXh0KTtcbiAgfVxuXG4gIGlmICghYXV0aCkge1xuICAgIHJldHVybiByZXF1ZXN0O1xuICB9XG4gIGlmIChhdXRoLmlzTWFzdGVyKSB7XG4gICAgcmVxdWVzdFsnbWFzdGVyJ10gPSB0cnVlO1xuICB9XG4gIGlmIChhdXRoLnVzZXIpIHtcbiAgICByZXF1ZXN0Wyd1c2VyJ10gPSBhdXRoLnVzZXI7XG4gIH1cbiAgaWYgKGF1dGguaW5zdGFsbGF0aW9uSWQpIHtcbiAgICByZXF1ZXN0WydpbnN0YWxsYXRpb25JZCddID0gYXV0aC5pbnN0YWxsYXRpb25JZDtcbiAgfVxuICByZXR1cm4gcmVxdWVzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RRdWVyeU9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgcXVlcnksIGNvdW50LCBjb25maWcsIGNvbnRleHQsIGlzR2V0KSB7XG4gIGlzR2V0ID0gISFpc0dldDtcblxuICB2YXIgcmVxdWVzdCA9IHtcbiAgICB0cmlnZ2VyTmFtZTogdHJpZ2dlclR5cGUsXG4gICAgcXVlcnksXG4gICAgbWFzdGVyOiBmYWxzZSxcbiAgICBjb3VudCxcbiAgICBsb2c6IGNvbmZpZy5sb2dnZXJDb250cm9sbGVyLFxuICAgIGlzR2V0LFxuICAgIGhlYWRlcnM6IGNvbmZpZy5oZWFkZXJzLFxuICAgIGlwOiBjb25maWcuaXAsXG4gICAgY29udGV4dDogY29udGV4dCB8fCB7fSxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbi8vIENyZWF0ZXMgdGhlIHJlc3BvbnNlIG9iamVjdCwgYW5kIHVzZXMgdGhlIHJlcXVlc3Qgb2JqZWN0IHRvIHBhc3MgZGF0YVxuLy8gVGhlIEFQSSB3aWxsIGNhbGwgdGhpcyB3aXRoIFJFU1QgQVBJIGZvcm1hdHRlZCBvYmplY3RzLCB0aGlzIHdpbGxcbi8vIHRyYW5zZm9ybSB0aGVtIHRvIFBhcnNlLk9iamVjdCBpbnN0YW5jZXMgZXhwZWN0ZWQgYnkgQ2xvdWQgQ29kZS5cbi8vIEFueSBjaGFuZ2VzIG1hZGUgdG8gdGhlIG9iamVjdCBpbiBhIGJlZm9yZVNhdmUgd2lsbCBiZSBpbmNsdWRlZC5cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXNwb25zZU9iamVjdChyZXF1ZXN0LCByZXNvbHZlLCByZWplY3QpIHtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiBmdW5jdGlvbiAocmVzcG9uc2UpIHtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlckZpbmQpIHtcbiAgICAgICAgaWYgKCFyZXNwb25zZSkge1xuICAgICAgICAgIHJlc3BvbnNlID0gcmVxdWVzdC5vYmplY3RzO1xuICAgICAgICB9XG4gICAgICAgIHJlc3BvbnNlID0gcmVzcG9uc2UubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgcmV0dXJuIG9iamVjdC50b0pTT04oKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICAgIC8vIFVzZSB0aGUgSlNPTiByZXNwb25zZVxuICAgICAgaWYgKFxuICAgICAgICByZXNwb25zZSAmJlxuICAgICAgICB0eXBlb2YgcmVzcG9uc2UgPT09ICdvYmplY3QnICYmXG4gICAgICAgICFyZXF1ZXN0Lm9iamVjdC5lcXVhbHMocmVzcG9uc2UpICYmXG4gICAgICAgIHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmJlZm9yZVNhdmVcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICB9XG4gICAgICBpZiAocmVzcG9uc2UgJiYgdHlwZW9mIHJlc3BvbnNlID09PSAnb2JqZWN0JyAmJiByZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5hZnRlclNhdmUpIHtcbiAgICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QudHJpZ2dlck5hbWUgPT09IFR5cGVzLmFmdGVyU2F2ZSkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZSgpO1xuICAgICAgfVxuICAgICAgcmVzcG9uc2UgPSB7fTtcbiAgICAgIGlmIChyZXF1ZXN0LnRyaWdnZXJOYW1lID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgIHJlc3BvbnNlWydvYmplY3QnXSA9IHJlcXVlc3Qub2JqZWN0Ll9nZXRTYXZlSlNPTigpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc29sdmUocmVzcG9uc2UpO1xuICAgIH0sXG4gICAgZXJyb3I6IGZ1bmN0aW9uIChlcnJvcikge1xuICAgICAgY29uc3QgZSA9IHJlc29sdmVFcnJvcihlcnJvciwge1xuICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICBtZXNzYWdlOiAnU2NyaXB0IGZhaWxlZC4gVW5rbm93biBlcnJvci4nLFxuICAgICAgfSk7XG4gICAgICByZWplY3QoZSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdXNlcklkRm9yTG9nKGF1dGgpIHtcbiAgcmV0dXJuIGF1dGggJiYgYXV0aC51c2VyID8gYXV0aC51c2VyLmlkIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBsb2dUcmlnZ2VyQWZ0ZXJIb29rKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIGlucHV0LCBhdXRoKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGxvZ2dlci5pbmZvKFxuICAgIGAke3RyaWdnZXJUeXBlfSB0cmlnZ2VyZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIHVzZXI6IHVzZXJJZEZvckxvZyhhdXRoKSxcbiAgICB9XG4gICk7XG59XG5cbmZ1bmN0aW9uIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgcmVzdWx0LCBhdXRoKSB7XG4gIGNvbnN0IGNsZWFuSW5wdXQgPSBsb2dnZXIudHJ1bmNhdGVMb2dNZXNzYWdlKEpTT04uc3RyaW5naWZ5KGlucHV0KSk7XG4gIGNvbnN0IGNsZWFuUmVzdWx0ID0gbG9nZ2VyLnRydW5jYXRlTG9nTWVzc2FnZShKU09OLnN0cmluZ2lmeShyZXN1bHQpKTtcbiAgbG9nZ2VyLmluZm8oXG4gICAgYCR7dHJpZ2dlclR5cGV9IHRyaWdnZXJlZCBmb3IgJHtjbGFzc05hbWV9IGZvciB1c2VyICR7dXNlcklkRm9yTG9nKFxuICAgICAgYXV0aFxuICAgICl9OlxcbiAgSW5wdXQ6ICR7Y2xlYW5JbnB1dH1cXG4gIFJlc3VsdDogJHtjbGVhblJlc3VsdH1gLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHRyaWdnZXJUeXBlLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZnVuY3Rpb24gbG9nVHJpZ2dlckVycm9yQmVmb3JlSG9vayh0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCBpbnB1dCwgYXV0aCwgZXJyb3IpIHtcbiAgY29uc3QgY2xlYW5JbnB1dCA9IGxvZ2dlci50cnVuY2F0ZUxvZ01lc3NhZ2UoSlNPTi5zdHJpbmdpZnkoaW5wdXQpKTtcbiAgbG9nZ2VyLmVycm9yKFxuICAgIGAke3RyaWdnZXJUeXBlfSBmYWlsZWQgZm9yICR7Y2xhc3NOYW1lfSBmb3IgdXNlciAke3VzZXJJZEZvckxvZyhcbiAgICAgIGF1dGhcbiAgICApfTpcXG4gIElucHV0OiAke2NsZWFuSW5wdXR9XFxuICBFcnJvcjogJHtKU09OLnN0cmluZ2lmeShlcnJvcil9YCxcbiAgICB7XG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgIGVycm9yLFxuICAgICAgdXNlcjogdXNlcklkRm9yTG9nKGF1dGgpLFxuICAgIH1cbiAgKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuQWZ0ZXJGaW5kVHJpZ2dlcihcbiAgdHJpZ2dlclR5cGUsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgb2JqZWN0cyxcbiAgY29uZmlnLFxuICBxdWVyeSxcbiAgY29udGV4dFxuKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICAgIGlmICghdHJpZ2dlcikge1xuICAgICAgcmV0dXJuIHJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgcmVxdWVzdCA9IGdldFJlcXVlc3RPYmplY3QodHJpZ2dlclR5cGUsIGF1dGgsIG51bGwsIG51bGwsIGNvbmZpZywgY29udGV4dCk7XG4gICAgaWYgKHF1ZXJ5KSB7XG4gICAgICByZXF1ZXN0LnF1ZXJ5ID0gcXVlcnk7XG4gICAgfVxuICAgIGNvbnN0IHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIHJlc29sdmUob2JqZWN0KTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9XG4gICAgKTtcbiAgICBsb2dUcmlnZ2VyU3VjY2Vzc0JlZm9yZUhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgJ0FmdGVyRmluZCcsIEpTT04uc3RyaW5naWZ5KG9iamVjdHMpLCBhdXRoKTtcbiAgICByZXF1ZXN0Lm9iamVjdHMgPSBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgLy9zZXR0aW5nIHRoZSBjbGFzcyBuYW1lIHRvIHRyYW5zZm9ybSBpbnRvIHBhcnNlIG9iamVjdFxuICAgICAgb2JqZWN0LmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQYXJzZS5PYmplY3QuZnJvbUpTT04ob2JqZWN0KTtcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgICAgcmV0dXJuIHJlcXVlc3Qub2JqZWN0cztcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXNwb25zZSA9IHRyaWdnZXIocmVxdWVzdCk7XG4gICAgICAgIGlmIChyZXNwb25zZSAmJiB0eXBlb2YgcmVzcG9uc2UudGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgIHJldHVybiByZXNwb25zZS50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKCFyZXN1bHRzKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICAgICAgICAgICdBZnRlckZpbmQgZXhwZWN0IHJlc3VsdHMgdG8gYmUgcmV0dXJuZWQgaW4gdGhlIHByb21pc2UnXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICB9KVxuICAgICAgLnRoZW4oc3VjY2VzcywgZXJyb3IpO1xuICB9KS50aGVuKHJlc3VsdHMgPT4ge1xuICAgIGxvZ1RyaWdnZXJBZnRlckhvb2sodHJpZ2dlclR5cGUsIGNsYXNzTmFtZSwgSlNPTi5zdHJpbmdpZnkocmVzdWx0cyksIGF1dGgpO1xuICAgIHJldHVybiByZXN1bHRzO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1heWJlUnVuUXVlcnlUcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgY2xhc3NOYW1lLFxuICByZXN0V2hlcmUsXG4gIHJlc3RPcHRpb25zLFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNvbnRleHQsXG4gIGlzR2V0XG4pIHtcbiAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHtcbiAgICAgIHJlc3RXaGVyZSxcbiAgICAgIHJlc3RPcHRpb25zLFxuICAgIH0pO1xuICB9XG4gIGNvbnN0IGpzb24gPSBPYmplY3QuYXNzaWduKHt9LCByZXN0T3B0aW9ucyk7XG4gIGpzb24ud2hlcmUgPSByZXN0V2hlcmU7XG5cbiAgY29uc3QgcGFyc2VRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWUpO1xuICBwYXJzZVF1ZXJ5LndpdGhKU09OKGpzb24pO1xuXG4gIGxldCBjb3VudCA9IGZhbHNlO1xuICBpZiAocmVzdE9wdGlvbnMpIHtcbiAgICBjb3VudCA9ICEhcmVzdE9wdGlvbnMuY291bnQ7XG4gIH1cbiAgY29uc3QgcmVxdWVzdE9iamVjdCA9IGdldFJlcXVlc3RRdWVyeU9iamVjdChcbiAgICB0cmlnZ2VyVHlwZSxcbiAgICBhdXRoLFxuICAgIHBhcnNlUXVlcnksXG4gICAgY291bnQsXG4gICAgY29uZmlnLFxuICAgIGNvbnRleHQsXG4gICAgaXNHZXRcbiAgKTtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3RPYmplY3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgICAgIHJldHVybiByZXF1ZXN0T2JqZWN0LnF1ZXJ5O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRyaWdnZXIocmVxdWVzdE9iamVjdCk7XG4gICAgfSlcbiAgICAudGhlbihcbiAgICAgIHJlc3VsdCA9PiB7XG4gICAgICAgIGxldCBxdWVyeVJlc3VsdCA9IHBhcnNlUXVlcnk7XG4gICAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0IGluc3RhbmNlb2YgUGFyc2UuUXVlcnkpIHtcbiAgICAgICAgICBxdWVyeVJlc3VsdCA9IHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBqc29uUXVlcnkgPSBxdWVyeVJlc3VsdC50b0pTT04oKTtcbiAgICAgICAgaWYgKGpzb25RdWVyeS53aGVyZSkge1xuICAgICAgICAgIHJlc3RXaGVyZSA9IGpzb25RdWVyeS53aGVyZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmxpbWl0KSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5saW1pdCA9IGpzb25RdWVyeS5saW1pdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LnNraXApIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLnNraXAgPSBqc29uUXVlcnkuc2tpcDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmluY2x1ZGUpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmluY2x1ZGUgPSBqc29uUXVlcnkuaW5jbHVkZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmV4Y2x1ZGVLZXlzKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5leGNsdWRlS2V5cyA9IGpzb25RdWVyeS5leGNsdWRlS2V5cztcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmV4cGxhaW4pIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmV4cGxhaW4gPSBqc29uUXVlcnkuZXhwbGFpbjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmtleXMpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmtleXMgPSBqc29uUXVlcnkua2V5cztcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5Lm9yZGVyKSB7XG4gICAgICAgICAgcmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICByZXN0T3B0aW9ucy5vcmRlciA9IGpzb25RdWVyeS5vcmRlcjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoanNvblF1ZXJ5LmhpbnQpIHtcbiAgICAgICAgICByZXN0T3B0aW9ucyA9IHJlc3RPcHRpb25zIHx8IHt9O1xuICAgICAgICAgIHJlc3RPcHRpb25zLmhpbnQgPSBqc29uUXVlcnkuaGludDtcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxdWVzdE9iamVjdC5yZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXF1ZXN0T2JqZWN0LnJlYWRQcmVmZXJlbmNlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0T2JqZWN0LmluY2x1ZGVSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZVJlYWRQcmVmZXJlbmNlID0gcmVxdWVzdE9iamVjdC5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZSkge1xuICAgICAgICAgIHJlc3RPcHRpb25zID0gcmVzdE9wdGlvbnMgfHwge307XG4gICAgICAgICAgcmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHJlcXVlc3RPYmplY3Quc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHJlc3RXaGVyZSxcbiAgICAgICAgICByZXN0T3B0aW9ucyxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgICBlcnIgPT4ge1xuICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlcnIsIHtcbiAgICAgICAgICBjb2RlOiBQYXJzZS5FcnJvci5TQ1JJUFRfRkFJTEVELFxuICAgICAgICAgIG1lc3NhZ2U6ICdTY3JpcHQgZmFpbGVkLiBVbmtub3duIGVycm9yLicsXG4gICAgICAgIH0pO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUVycm9yKG1lc3NhZ2UsIGRlZmF1bHRPcHRzKSB7XG4gIGlmICghZGVmYXVsdE9wdHMpIHtcbiAgICBkZWZhdWx0T3B0cyA9IHt9O1xuICB9XG4gIGlmICghbWVzc2FnZSkge1xuICAgIHJldHVybiBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBkZWZhdWx0T3B0cy5jb2RlIHx8IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQsXG4gICAgICBkZWZhdWx0T3B0cy5tZXNzYWdlIHx8ICdTY3JpcHQgZmFpbGVkLidcbiAgICApO1xuICB9XG4gIGlmIChtZXNzYWdlIGluc3RhbmNlb2YgUGFyc2UuRXJyb3IpIHtcbiAgICByZXR1cm4gbWVzc2FnZTtcbiAgfVxuXG4gIGNvbnN0IGNvZGUgPSBkZWZhdWx0T3B0cy5jb2RlIHx8IFBhcnNlLkVycm9yLlNDUklQVF9GQUlMRUQ7XG4gIC8vIElmIGl0J3MgYW4gZXJyb3IsIG1hcmsgaXQgYXMgYSBzY3JpcHQgZmFpbGVkXG4gIGlmICh0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gbmV3IFBhcnNlLkVycm9yKGNvZGUsIG1lc3NhZ2UpO1xuICB9XG4gIGNvbnN0IGVycm9yID0gbmV3IFBhcnNlLkVycm9yKGNvZGUsIG1lc3NhZ2UubWVzc2FnZSB8fCBtZXNzYWdlKTtcbiAgaWYgKG1lc3NhZ2UgaW5zdGFuY2VvZiBFcnJvcikge1xuICAgIGVycm9yLnN0YWNrID0gbWVzc2FnZS5zdGFjaztcbiAgfVxuICByZXR1cm4gZXJyb3I7XG59XG5leHBvcnQgZnVuY3Rpb24gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgZnVuY3Rpb25OYW1lKSB7XG4gIGNvbnN0IHRoZVZhbGlkYXRvciA9IGdldFZhbGlkYXRvcihmdW5jdGlvbk5hbWUsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIXRoZVZhbGlkYXRvcikge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodHlwZW9mIHRoZVZhbGlkYXRvciA9PT0gJ29iamVjdCcgJiYgdGhlVmFsaWRhdG9yLnNraXBXaXRoTWFzdGVyS2V5ICYmIHJlcXVlc3QubWFzdGVyKSB7XG4gICAgcmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSA9IHRydWU7XG4gIH1cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHR5cGVvZiB0aGVWYWxpZGF0b3IgPT09ICdvYmplY3QnXG4gICAgICAgICAgPyBidWlsdEluVHJpZ2dlclZhbGlkYXRvcih0aGVWYWxpZGF0b3IsIHJlcXVlc3QpXG4gICAgICAgICAgOiB0aGVWYWxpZGF0b3IocmVxdWVzdCk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGUgPT4ge1xuICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlLCB7XG4gICAgICAgICAgY29kZTogUGFyc2UuRXJyb3IuVkFMSURBVElPTl9FUlJPUixcbiAgICAgICAgICBtZXNzYWdlOiAnVmFsaWRhdGlvbiBmYWlsZWQuJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICB9KTtcbiAgfSk7XG59XG5mdW5jdGlvbiBidWlsdEluVHJpZ2dlclZhbGlkYXRvcihvcHRpb25zLCByZXF1ZXN0KSB7XG4gIGlmIChyZXF1ZXN0Lm1hc3RlciAmJiAhb3B0aW9ucy52YWxpZGF0ZU1hc3RlcktleSkge1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgcmVxVXNlciA9IHJlcXVlc3QudXNlcjtcbiAgaWYgKFxuICAgICFyZXFVc2VyICYmXG4gICAgcmVxdWVzdC5vYmplY3QgJiZcbiAgICByZXF1ZXN0Lm9iamVjdC5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAhcmVxdWVzdC5vYmplY3QuZXhpc3RlZCgpXG4gICkge1xuICAgIHJlcVVzZXIgPSByZXF1ZXN0Lm9iamVjdDtcbiAgfVxuICBpZiAob3B0aW9ucy5yZXF1aXJlVXNlciAmJiAhcmVxVXNlcikge1xuICAgIHRocm93ICdWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIGxvZ2luIHRvIGNvbnRpbnVlLic7XG4gIH1cbiAgaWYgKG9wdGlvbnMucmVxdWlyZU1hc3RlciAmJiAhcmVxdWVzdC5tYXN0ZXIpIHtcbiAgICB0aHJvdyAnVmFsaWRhdGlvbiBmYWlsZWQuIE1hc3RlciBrZXkgaXMgcmVxdWlyZWQgdG8gY29tcGxldGUgdGhpcyByZXF1ZXN0Lic7XG4gIH1cbiAgbGV0IHBhcmFtcyA9IHJlcXVlc3QucGFyYW1zIHx8IHt9O1xuICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICBwYXJhbXMgPSByZXF1ZXN0Lm9iamVjdC50b0pTT04oKTtcbiAgfVxuICBjb25zdCByZXF1aXJlZFBhcmFtID0ga2V5ID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IHBhcmFtc1trZXldO1xuICAgIGlmICh2YWx1ZSA9PSBudWxsKSB7XG4gICAgICB0aHJvdyBgVmFsaWRhdGlvbiBmYWlsZWQuIFBsZWFzZSBzcGVjaWZ5IGRhdGEgZm9yICR7a2V5fS5gO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2YWxpZGF0ZU9wdGlvbnMgPSAob3B0LCBrZXksIHZhbCkgPT4ge1xuICAgIGxldCBvcHRzID0gb3B0Lm9wdGlvbnM7XG4gICAgaWYgKHR5cGVvZiBvcHRzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBvcHRzKHZhbCk7XG4gICAgICAgIGlmICghcmVzdWx0ICYmIHJlc3VsdCAhPSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKCFlKSB7XG4gICAgICAgICAgdGhyb3cgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB2YWx1ZSBmb3IgJHtrZXl9LmA7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBvcHQuZXJyb3IgfHwgZS5tZXNzYWdlIHx8IGU7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghQXJyYXkuaXNBcnJheShvcHRzKSkge1xuICAgICAgb3B0cyA9IFtvcHQub3B0aW9uc107XG4gICAgfVxuXG4gICAgaWYgKCFvcHRzLmluY2x1ZGVzKHZhbCkpIHtcbiAgICAgIHRocm93IChcbiAgICAgICAgb3B0LmVycm9yIHx8IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCBvcHRpb24gZm9yICR7a2V5fS4gRXhwZWN0ZWQ6ICR7b3B0cy5qb2luKCcsICcpfWBcbiAgICAgICk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGdldFR5cGUgPSBmbiA9PiB7XG4gICAgY29uc3QgbWF0Y2ggPSBmbiAmJiBmbi50b1N0cmluZygpLm1hdGNoKC9eXFxzKmZ1bmN0aW9uIChcXHcrKS8pO1xuICAgIHJldHVybiAobWF0Y2ggPyBtYXRjaFsxXSA6ICcnKS50b0xvd2VyQ2FzZSgpO1xuICB9O1xuICBpZiAoQXJyYXkuaXNBcnJheShvcHRpb25zLmZpZWxkcykpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBvcHRpb25zLmZpZWxkcykge1xuICAgICAgcmVxdWlyZWRQYXJhbShrZXkpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBvcHRpb25zLmZpZWxkcykge1xuICAgICAgY29uc3Qgb3B0ID0gb3B0aW9ucy5maWVsZHNba2V5XTtcbiAgICAgIGxldCB2YWwgPSBwYXJhbXNba2V5XTtcbiAgICAgIGlmICh0eXBlb2Ygb3B0ID09PSAnc3RyaW5nJykge1xuICAgICAgICByZXF1aXJlZFBhcmFtKG9wdCk7XG4gICAgICB9XG4gICAgICBpZiAodHlwZW9mIG9wdCA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgaWYgKG9wdC5kZWZhdWx0ICE9IG51bGwgJiYgdmFsID09IG51bGwpIHtcbiAgICAgICAgICB2YWwgPSBvcHQuZGVmYXVsdDtcbiAgICAgICAgICBwYXJhbXNba2V5XSA9IHZhbDtcbiAgICAgICAgICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICAgICAgICAgIHJlcXVlc3Qub2JqZWN0LnNldChrZXksIHZhbCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChvcHQuY29uc3RhbnQgJiYgcmVxdWVzdC5vYmplY3QpIHtcbiAgICAgICAgICBpZiAocmVxdWVzdC5vcmlnaW5hbCkge1xuICAgICAgICAgICAgcmVxdWVzdC5vYmplY3Quc2V0KGtleSwgcmVxdWVzdC5vcmlnaW5hbC5nZXQoa2V5KSk7XG4gICAgICAgICAgfSBlbHNlIGlmIChvcHQuZGVmYXVsdCAhPSBudWxsKSB7XG4gICAgICAgICAgICByZXF1ZXN0Lm9iamVjdC5zZXQoa2V5LCBvcHQuZGVmYXVsdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChvcHQucmVxdWlyZWQpIHtcbiAgICAgICAgICByZXF1aXJlZFBhcmFtKGtleSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC50eXBlKSB7XG4gICAgICAgICAgY29uc3QgdHlwZSA9IGdldFR5cGUob3B0LnR5cGUpO1xuICAgICAgICAgIGlmICh0eXBlID09ICdhcnJheScgJiYgIUFycmF5LmlzQXJyYXkodmFsKSkge1xuICAgICAgICAgICAgdGhyb3cgYFZhbGlkYXRpb24gZmFpbGVkLiBJbnZhbGlkIHR5cGUgZm9yICR7a2V5fS4gRXhwZWN0ZWQ6IGFycmF5YDtcbiAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiB2YWwgIT09IHR5cGUpIHtcbiAgICAgICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gSW52YWxpZCB0eXBlIGZvciAke2tleX0uIEV4cGVjdGVkOiAke3R5cGV9YDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdC5vcHRpb25zKSB7XG4gICAgICAgICAgdmFsaWRhdGVPcHRpb25zKG9wdCwga2V5LCB2YWwpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGNvbnN0IHVzZXJLZXlzID0gb3B0aW9ucy5yZXF1aXJlVXNlcktleXMgfHwgW107XG4gIGlmIChBcnJheS5pc0FycmF5KHVzZXJLZXlzKSkge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIHVzZXJLZXlzKSB7XG4gICAgICBpZiAoIXJlcVVzZXIpIHtcbiAgICAgICAgdGhyb3cgJ1BsZWFzZSBsb2dpbiB0byBtYWtlIHRoaXMgcmVxdWVzdC4nO1xuICAgICAgfVxuXG4gICAgICBpZiAocmVxVXNlci5nZXQoa2V5KSA9PSBudWxsKSB7XG4gICAgICAgIHRocm93IGBWYWxpZGF0aW9uIGZhaWxlZC4gUGxlYXNlIHNldCBkYXRhIGZvciAke2tleX0gb24geW91ciBhY2NvdW50LmA7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2UgaWYgKHR5cGVvZiB1c2VyS2V5cyA9PT0gJ29iamVjdCcpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBvcHRpb25zLnJlcXVpcmVVc2VyS2V5cykge1xuICAgICAgY29uc3Qgb3B0ID0gb3B0aW9ucy5yZXF1aXJlVXNlcktleXNba2V5XTtcbiAgICAgIGlmIChvcHQub3B0aW9ucykge1xuICAgICAgICB2YWxpZGF0ZU9wdGlvbnMob3B0LCBrZXksIHJlcVVzZXIuZ2V0KGtleSkpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG4vLyBUbyBiZSB1c2VkIGFzIHBhcnQgb2YgdGhlIHByb21pc2UgY2hhaW4gd2hlbiBzYXZpbmcvZGVsZXRpbmcgYW4gb2JqZWN0XG4vLyBXaWxsIHJlc29sdmUgc3VjY2Vzc2Z1bGx5IGlmIG5vIHRyaWdnZXIgaXMgY29uZmlndXJlZFxuLy8gUmVzb2x2ZXMgdG8gYW4gb2JqZWN0LCBlbXB0eSBvciBjb250YWluaW5nIGFuIG9iamVjdCBrZXkuIEEgYmVmb3JlU2F2ZVxuLy8gdHJpZ2dlciB3aWxsIHNldCB0aGUgb2JqZWN0IGtleSB0byB0aGUgcmVzdCBmb3JtYXQgb2JqZWN0IHRvIHNhdmUuXG4vLyBvcmlnaW5hbFBhcnNlT2JqZWN0IGlzIG9wdGlvbmFsLCB3ZSBvbmx5IG5lZWQgdGhhdCBmb3IgYmVmb3JlL2FmdGVyU2F2ZSBmdW5jdGlvbnNcbmV4cG9ydCBmdW5jdGlvbiBtYXliZVJ1blRyaWdnZXIoXG4gIHRyaWdnZXJUeXBlLFxuICBhdXRoLFxuICBwYXJzZU9iamVjdCxcbiAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgY29uZmlnLFxuICBjb250ZXh0XG4pIHtcbiAgaWYgKCFwYXJzZU9iamVjdCkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICB9XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIHRyaWdnZXIgPSBnZXRUcmlnZ2VyKHBhcnNlT2JqZWN0LmNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIGNvbmZpZy5hcHBsaWNhdGlvbklkKTtcbiAgICBpZiAoIXRyaWdnZXIpIHJldHVybiByZXNvbHZlKCk7XG4gICAgdmFyIHJlcXVlc3QgPSBnZXRSZXF1ZXN0T2JqZWN0KFxuICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICBhdXRoLFxuICAgICAgcGFyc2VPYmplY3QsXG4gICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgY29uZmlnLFxuICAgICAgY29udGV4dFxuICAgICk7XG4gICAgdmFyIHsgc3VjY2VzcywgZXJyb3IgfSA9IGdldFJlc3BvbnNlT2JqZWN0KFxuICAgICAgcmVxdWVzdCxcbiAgICAgIG9iamVjdCA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJTdWNjZXNzQmVmb3JlSG9vayhcbiAgICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgICBwYXJzZU9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgICAgcGFyc2VPYmplY3QudG9KU09OKCksXG4gICAgICAgICAgb2JqZWN0LFxuICAgICAgICAgIGF1dGhcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyU2F2ZSB8fFxuICAgICAgICAgIHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVEZWxldGUgfHxcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJEZWxldGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgT2JqZWN0LmFzc2lnbihjb250ZXh0LCByZXF1ZXN0LmNvbnRleHQpO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUob2JqZWN0KTtcbiAgICAgIH0sXG4gICAgICBlcnJvciA9PiB7XG4gICAgICAgIGxvZ1RyaWdnZXJFcnJvckJlZm9yZUhvb2soXG4gICAgICAgICAgdHJpZ2dlclR5cGUsXG4gICAgICAgICAgcGFyc2VPYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICAgIHBhcnNlT2JqZWN0LnRvSlNPTigpLFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgZXJyb3JcbiAgICAgICAgKTtcbiAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gQWZ0ZXJTYXZlIGFuZCBhZnRlckRlbGV0ZSB0cmlnZ2VycyBjYW4gcmV0dXJuIGEgcHJvbWlzZSwgd2hpY2ggaWYgdGhleVxuICAgIC8vIGRvLCBuZWVkcyB0byBiZSByZXNvbHZlZCBiZWZvcmUgdGhpcyBwcm9taXNlIGlzIHJlc29sdmVkLFxuICAgIC8vIHNvIHRyaWdnZXIgZXhlY3V0aW9uIGlzIHN5bmNlZCB3aXRoIFJlc3RXcml0ZS5leGVjdXRlKCkgY2FsbC5cbiAgICAvLyBJZiB0cmlnZ2VycyBkbyBub3QgcmV0dXJuIGEgcHJvbWlzZSwgdGhleSBjYW4gcnVuIGFzeW5jIGNvZGUgcGFyYWxsZWxcbiAgICAvLyB0byB0aGUgUmVzdFdyaXRlLmV4ZWN1dGUoKSBjYWxsLlxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gbWF5YmVSdW5WYWxpZGF0b3IocmVxdWVzdCwgYCR7dHJpZ2dlclR5cGV9LiR7cGFyc2VPYmplY3QuY2xhc3NOYW1lfWApO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcHJvbWlzZSA9IHRyaWdnZXIocmVxdWVzdCk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB0cmlnZ2VyVHlwZSA9PT0gVHlwZXMuYWZ0ZXJTYXZlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyRGVsZXRlIHx8XG4gICAgICAgICAgdHJpZ2dlclR5cGUgPT09IFR5cGVzLmFmdGVyTG9naW5cbiAgICAgICAgKSB7XG4gICAgICAgICAgbG9nVHJpZ2dlckFmdGVySG9vayh0cmlnZ2VyVHlwZSwgcGFyc2VPYmplY3QuY2xhc3NOYW1lLCBwYXJzZU9iamVjdC50b0pTT04oKSwgYXV0aCk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gYmVmb3JlU2F2ZSBpcyBleHBlY3RlZCB0byByZXR1cm4gbnVsbCAobm90aGluZylcbiAgICAgICAgaWYgKHRyaWdnZXJUeXBlID09PSBUeXBlcy5iZWZvcmVTYXZlKSB7XG4gICAgICAgICAgaWYgKHByb21pc2UgJiYgdHlwZW9mIHByb21pc2UudGhlbiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHByb21pc2UudGhlbihyZXNwb25zZSA9PiB7XG4gICAgICAgICAgICAgIC8vIHJlc3BvbnNlLm9iamVjdCBtYXkgY29tZSBmcm9tIGV4cHJlc3Mgcm91dGluZyBiZWZvcmUgaG9va1xuICAgICAgICAgICAgICBpZiAocmVzcG9uc2UgJiYgcmVzcG9uc2Uub2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgICB9KVxuICAgICAgLnRoZW4oc3VjY2VzcywgZXJyb3IpO1xuICB9KTtcbn1cblxuLy8gQ29udmVydHMgYSBSRVNULWZvcm1hdCBvYmplY3QgdG8gYSBQYXJzZS5PYmplY3Rcbi8vIGRhdGEgaXMgZWl0aGVyIGNsYXNzTmFtZSBvciBhbiBvYmplY3RcbmV4cG9ydCBmdW5jdGlvbiBpbmZsYXRlKGRhdGEsIHJlc3RPYmplY3QpIHtcbiAgdmFyIGNvcHkgPSB0eXBlb2YgZGF0YSA9PSAnb2JqZWN0JyA/IGRhdGEgOiB7IGNsYXNzTmFtZTogZGF0YSB9O1xuICBmb3IgKHZhciBrZXkgaW4gcmVzdE9iamVjdCkge1xuICAgIGNvcHlba2V5XSA9IHJlc3RPYmplY3Rba2V5XTtcbiAgfVxuICByZXR1cm4gUGFyc2UuT2JqZWN0LmZyb21KU09OKGNvcHkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyhkYXRhLCBhcHBsaWNhdGlvbklkID0gUGFyc2UuYXBwbGljYXRpb25JZCkge1xuICBpZiAoIV90cmlnZ2VyU3RvcmUgfHwgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0gfHwgIV90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIF90cmlnZ2VyU3RvcmVbYXBwbGljYXRpb25JZF0uTGl2ZVF1ZXJ5LmZvckVhY2goaGFuZGxlciA9PiBoYW5kbGVyKGRhdGEpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcXVlc3RGaWxlT2JqZWN0KHRyaWdnZXJUeXBlLCBhdXRoLCBmaWxlT2JqZWN0LCBjb25maWcpIHtcbiAgY29uc3QgcmVxdWVzdCA9IHtcbiAgICAuLi5maWxlT2JqZWN0LFxuICAgIHRyaWdnZXJOYW1lOiB0cmlnZ2VyVHlwZSxcbiAgICBtYXN0ZXI6IGZhbHNlLFxuICAgIGxvZzogY29uZmlnLmxvZ2dlckNvbnRyb2xsZXIsXG4gICAgaGVhZGVyczogY29uZmlnLmhlYWRlcnMsXG4gICAgaXA6IGNvbmZpZy5pcCxcbiAgfTtcblxuICBpZiAoIWF1dGgpIHtcbiAgICByZXR1cm4gcmVxdWVzdDtcbiAgfVxuICBpZiAoYXV0aC5pc01hc3Rlcikge1xuICAgIHJlcXVlc3RbJ21hc3RlciddID0gdHJ1ZTtcbiAgfVxuICBpZiAoYXV0aC51c2VyKSB7XG4gICAgcmVxdWVzdFsndXNlciddID0gYXV0aC51c2VyO1xuICB9XG4gIGlmIChhdXRoLmluc3RhbGxhdGlvbklkKSB7XG4gICAgcmVxdWVzdFsnaW5zdGFsbGF0aW9uSWQnXSA9IGF1dGguaW5zdGFsbGF0aW9uSWQ7XG4gIH1cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkZpbGVUcmlnZ2VyKFxuICB0cmlnZ2VyVHlwZSxcbiAgZmlsZU9iamVjdCxcbiAgY29uZmlnLFxuICBhdXRoXG4pIHtcbiAgY29uc3QgZmlsZVRyaWdnZXIgPSBnZXRGaWxlVHJpZ2dlcih0cmlnZ2VyVHlwZSwgY29uZmlnLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAodHlwZW9mIGZpbGVUcmlnZ2VyID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBnZXRSZXF1ZXN0RmlsZU9iamVjdCh0cmlnZ2VyVHlwZSwgYXV0aCwgZmlsZU9iamVjdCwgY29uZmlnKTtcbiAgICAgIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke0ZpbGVDbGFzc05hbWV9YCk7XG4gICAgICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgICAgICByZXR1cm4gZmlsZU9iamVjdDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZpbGVUcmlnZ2VyKHJlcXVlc3QpO1xuICAgICAgbG9nVHJpZ2dlclN1Y2Nlc3NCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkZpbGUnLFxuICAgICAgICB7IC4uLmZpbGVPYmplY3QuZmlsZS50b0pTT04oKSwgZmlsZVNpemU6IGZpbGVPYmplY3QuZmlsZVNpemUgfSxcbiAgICAgICAgcmVzdWx0LFxuICAgICAgICBhdXRoXG4gICAgICApO1xuICAgICAgcmV0dXJuIHJlc3VsdCB8fCBmaWxlT2JqZWN0O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBsb2dUcmlnZ2VyRXJyb3JCZWZvcmVIb29rKFxuICAgICAgICB0cmlnZ2VyVHlwZSxcbiAgICAgICAgJ1BhcnNlLkZpbGUnLFxuICAgICAgICB7IC4uLmZpbGVPYmplY3QuZmlsZS50b0pTT04oKSwgZmlsZVNpemU6IGZpbGVPYmplY3QuZmlsZVNpemUgfSxcbiAgICAgICAgYXV0aCxcbiAgICAgICAgZXJyb3JcbiAgICAgICk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZpbGVPYmplY3Q7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkNvbm5lY3RUcmlnZ2VyKHRyaWdnZXJUeXBlLCByZXF1ZXN0KSB7XG4gIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKENvbm5lY3RDbGFzc05hbWUsIHRyaWdnZXJUeXBlLCBQYXJzZS5hcHBsaWNhdGlvbklkKTtcbiAgaWYgKCF0cmlnZ2VyKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlcXVlc3QudXNlciA9IGF3YWl0IHVzZXJGb3JTZXNzaW9uVG9rZW4ocmVxdWVzdC5zZXNzaW9uVG9rZW4pO1xuICBhd2FpdCBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtDb25uZWN0Q2xhc3NOYW1lfWApO1xuICBpZiAocmVxdWVzdC5za2lwV2l0aE1hc3RlcktleSkge1xuICAgIHJldHVybjtcbiAgfVxuICByZXR1cm4gdHJpZ2dlcihyZXF1ZXN0KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1heWJlUnVuU3Vic2NyaWJlVHJpZ2dlcih0cmlnZ2VyVHlwZSwgY2xhc3NOYW1lLCByZXF1ZXN0KSB7XG4gIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgdHJpZ2dlclR5cGUsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICBpZiAoIXRyaWdnZXIpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcGFyc2VRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWUpO1xuICBwYXJzZVF1ZXJ5LndpdGhKU09OKHJlcXVlc3QucXVlcnkpO1xuICByZXF1ZXN0LnF1ZXJ5ID0gcGFyc2VRdWVyeTtcbiAgcmVxdWVzdC51c2VyID0gYXdhaXQgdXNlckZvclNlc3Npb25Ub2tlbihyZXF1ZXN0LnNlc3Npb25Ub2tlbik7XG4gIGF3YWl0IG1heWJlUnVuVmFsaWRhdG9yKHJlcXVlc3QsIGAke3RyaWdnZXJUeXBlfS4ke2NsYXNzTmFtZX1gKTtcbiAgaWYgKHJlcXVlc3Quc2tpcFdpdGhNYXN0ZXJLZXkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgYXdhaXQgdHJpZ2dlcihyZXF1ZXN0KTtcbiAgY29uc3QgcXVlcnkgPSByZXF1ZXN0LnF1ZXJ5LnRvSlNPTigpO1xuICBpZiAocXVlcnkua2V5cykge1xuICAgIHF1ZXJ5LmZpZWxkcyA9IHF1ZXJ5LmtleXMuc3BsaXQoJywnKTtcbiAgfVxuICByZXF1ZXN0LnF1ZXJ5ID0gcXVlcnk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYXliZVJ1bkFmdGVyRXZlbnRUcmlnZ2VyKHRyaWdnZXJUeXBlLCBjbGFzc05hbWUsIHJlcXVlc3QpIHtcbiAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCB0cmlnZ2VyVHlwZSwgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gIGlmICghdHJpZ2dlcikge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAocmVxdWVzdC5vYmplY3QpIHtcbiAgICByZXF1ZXN0Lm9iamVjdCA9IFBhcnNlLk9iamVjdC5mcm9tSlNPTihyZXF1ZXN0Lm9iamVjdCk7XG4gIH1cbiAgaWYgKHJlcXVlc3Qub3JpZ2luYWwpIHtcbiAgICByZXF1ZXN0Lm9yaWdpbmFsID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKHJlcXVlc3Qub3JpZ2luYWwpO1xuICB9XG4gIHJlcXVlc3QudXNlciA9IGF3YWl0IHVzZXJGb3JTZXNzaW9uVG9rZW4ocmVxdWVzdC5zZXNzaW9uVG9rZW4pO1xuICBhd2FpdCBtYXliZVJ1blZhbGlkYXRvcihyZXF1ZXN0LCBgJHt0cmlnZ2VyVHlwZX0uJHtjbGFzc05hbWV9YCk7XG4gIGlmIChyZXF1ZXN0LnNraXBXaXRoTWFzdGVyS2V5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0cmlnZ2VyKHJlcXVlc3QpO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1c2VyRm9yU2Vzc2lvblRva2VuKHNlc3Npb25Ub2tlbikge1xuICBpZiAoIXNlc3Npb25Ub2tlbikge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBxID0gbmV3IFBhcnNlLlF1ZXJ5KCdfU2Vzc2lvbicpO1xuICBxLmVxdWFsVG8oJ3Nlc3Npb25Ub2tlbicsIHNlc3Npb25Ub2tlbik7XG4gIHEuaW5jbHVkZSgndXNlcicpO1xuICBjb25zdCBzZXNzaW9uID0gYXdhaXQgcS5maXJzdCh7IHVzZU1hc3RlcktleTogdHJ1ZSB9KTtcbiAgaWYgKCFzZXNzaW9uKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiBzZXNzaW9uLmdldCgndXNlcicpO1xufVxuIl19