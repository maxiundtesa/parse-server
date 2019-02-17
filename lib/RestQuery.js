"use strict";

// An object that encapsulates everything we need to run a 'find'
// operation, encoded in the REST API format.
var SchemaController = require('./Controllers/SchemaController');

var Parse = require('parse/node').Parse;

const triggers = require('./triggers');

const {
  continueWhile
} = require('parse/lib/node/promiseUtils');

const AlwaysSelectedKeys = ['objectId', 'createdAt', 'updatedAt', 'ACL']; // restOptions can include:
//   skip
//   limit
//   order
//   count
//   include
//   keys
//   redirectClassNameForKey

function RestQuery(config, auth, className, restWhere = {}, restOptions = {}, clientSDK) {
  this.config = config;
  this.auth = auth;
  this.className = className;
  this.restWhere = restWhere;
  this.restOptions = restOptions;
  this.clientSDK = clientSDK;
  this.response = null;
  this.findOptions = {};

  if (!this.auth.isMaster) {
    if (this.className == '_Session') {
      if (!this.auth.user) {
        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
      }

      this.restWhere = {
        $and: [this.restWhere, {
          user: {
            __type: 'Pointer',
            className: '_User',
            objectId: this.auth.user.id
          }
        }]
      };
    }
  }

  this.doCount = false;
  this.includeAll = false; // The format for this.include is not the same as the format for the
  // include option - it's the paths we should include, in order,
  // stored as arrays, taking into account that we need to include foo
  // before including foo.bar. Also it should dedupe.
  // For example, passing an arg of include=foo.bar,foo.baz could lead to
  // this.include = [['foo'], ['foo', 'baz'], ['foo', 'bar']]

  this.include = []; // If we have keys, we probably want to force some includes (n-1 level)
  // See issue: https://github.com/parse-community/parse-server/issues/3185

  if (restOptions.hasOwnProperty('keys')) {
    const keysForInclude = restOptions.keys.split(',').filter(key => {
      // At least 2 components
      return key.split('.').length > 1;
    }).map(key => {
      // Slice the last component (a.b.c -> a.b)
      // Otherwise we'll include one level too much.
      return key.slice(0, key.lastIndexOf('.'));
    }).join(','); // Concat the possibly present include string with the one from the keys
    // Dedup / sorting is handle in 'include' case.

    if (keysForInclude.length > 0) {
      if (!restOptions.include || restOptions.include.length == 0) {
        restOptions.include = keysForInclude;
      } else {
        restOptions.include += ',' + keysForInclude;
      }
    }
  }

  for (var option in restOptions) {
    switch (option) {
      case 'keys':
        {
          const keys = restOptions.keys.split(',').concat(AlwaysSelectedKeys);
          this.keys = Array.from(new Set(keys));
          break;
        }

      case 'count':
        this.doCount = true;
        break;

      case 'includeAll':
        this.includeAll = true;
        break;

      case 'distinct':
      case 'pipeline':
      case 'skip':
      case 'limit':
      case 'readPreference':
        this.findOptions[option] = restOptions[option];
        break;

      case 'order':
        var fields = restOptions.order.split(',');
        this.findOptions.sort = fields.reduce((sortMap, field) => {
          field = field.trim();

          if (field === '$score') {
            sortMap.score = {
              $meta: 'textScore'
            };
          } else if (field[0] == '-') {
            sortMap[field.slice(1)] = -1;
          } else {
            sortMap[field] = 1;
          }

          return sortMap;
        }, {});
        break;

      case 'include':
        {
          const paths = restOptions.include.split(',');

          if (paths.includes('*')) {
            this.includeAll = true;
            break;
          } // Load the existing includes (from keys)


          const pathSet = paths.reduce((memo, path) => {
            // Split each paths on . (a.b.c -> [a,b,c])
            // reduce to create all paths
            // ([a,b,c] -> {a: true, 'a.b': true, 'a.b.c': true})
            return path.split('.').reduce((memo, path, index, parts) => {
              memo[parts.slice(0, index + 1).join('.')] = true;
              return memo;
            }, memo);
          }, {});
          this.include = Object.keys(pathSet).map(s => {
            return s.split('.');
          }).sort((a, b) => {
            return a.length - b.length; // Sort by number of components
          });
          break;
        }

      case 'redirectClassNameForKey':
        this.redirectKey = restOptions.redirectClassNameForKey;
        this.redirectClassName = null;
        break;

      case 'includeReadPreference':
      case 'subqueryReadPreference':
        break;

      default:
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad option: ' + option);
    }
  }
} // A convenient method to perform all the steps of processing a query
// in order.
// Returns a promise for the response - an object with optional keys
// 'results' and 'count'.
// TODO: consolidate the replaceX functions


RestQuery.prototype.execute = function (executeOptions) {
  return Promise.resolve().then(() => {
    return this.buildRestWhere();
  }).then(() => {
    return this.handleIncludeAll();
  }).then(() => {
    return this.runFind(executeOptions);
  }).then(() => {
    return this.runCount();
  }).then(() => {
    return this.handleInclude();
  }).then(() => {
    return this.runAfterFindTrigger();
  }).then(() => {
    return this.response;
  });
};

RestQuery.prototype.each = function (callback) {
  const {
    config,
    auth,
    className,
    restWhere,
    restOptions,
    clientSDK
  } = this; // if the limit is set, use it

  restOptions.limit = restOptions.limit || 100;
  restOptions.order = 'objectId';
  let finished = false;
  return continueWhile(() => {
    return !finished;
  }, async () => {
    const query = new RestQuery(config, auth, className, restWhere, restOptions, clientSDK);
    const {
      results
    } = await query.execute();
    results.forEach(callback);
    finished = results.length < restOptions.limit;

    if (!finished) {
      restWhere.objectId = Object.assign({}, restWhere.objectId, {
        $gt: results[results.length - 1].objectId
      });
    }
  });
};

RestQuery.prototype.buildRestWhere = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.redirectClassNameForKey();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.replaceSelect();
  }).then(() => {
    return this.replaceDontSelect();
  }).then(() => {
    return this.replaceInQuery();
  }).then(() => {
    return this.replaceNotInQuery();
  }).then(() => {
    return this.replaceEquality();
  });
}; // Uses the Auth object to get the list of roles, adds the user id


RestQuery.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
    return Promise.resolve();
  }

  this.findOptions.acl = ['*'];

  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.findOptions.acl = this.findOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
}; // Changes the className if redirectClassNameForKey is set.
// Returns a promise.


RestQuery.prototype.redirectClassNameForKey = function () {
  if (!this.redirectKey) {
    return Promise.resolve();
  } // We need to change the class name based on the schema


  return this.config.database.redirectClassNameForKey(this.className, this.redirectKey).then(newClassName => {
    this.className = newClassName;
    this.redirectClassName = newClassName;
  });
}; // Validates this operation against the allowClientClassCreation config.


RestQuery.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
};

function transformInQuery(inQueryObject, className, results) {
  var values = [];

  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }

  delete inQueryObject['$inQuery'];

  if (Array.isArray(inQueryObject['$in'])) {
    inQueryObject['$in'] = inQueryObject['$in'].concat(values);
  } else {
    inQueryObject['$in'] = values;
  }
} // Replaces a $inQuery clause by running the subquery, if there is an
// $inQuery clause.
// The $inQuery clause turns into an $in with values that are just
// pointers to the objects returned in the subquery.


RestQuery.prototype.replaceInQuery = function () {
  var inQueryObject = findObjectWithKey(this.restWhere, '$inQuery');

  if (!inQueryObject) {
    return;
  } // The inQuery value must have precisely two keys - where and className


  var inQueryValue = inQueryObject['$inQuery'];

  if (!inQueryValue.where || !inQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $inQuery');
  }

  const additionalOptions = {
    redirectClassNameForKey: inQueryValue.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, inQueryValue.className, inQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformInQuery(inQueryObject, subquery.className, response.results); // Recurse to repeat

    return this.replaceInQuery();
  });
};

function transformNotInQuery(notInQueryObject, className, results) {
  var values = [];

  for (var result of results) {
    values.push({
      __type: 'Pointer',
      className: className,
      objectId: result.objectId
    });
  }

  delete notInQueryObject['$notInQuery'];

  if (Array.isArray(notInQueryObject['$nin'])) {
    notInQueryObject['$nin'] = notInQueryObject['$nin'].concat(values);
  } else {
    notInQueryObject['$nin'] = values;
  }
} // Replaces a $notInQuery clause by running the subquery, if there is an
// $notInQuery clause.
// The $notInQuery clause turns into a $nin with values that are just
// pointers to the objects returned in the subquery.


RestQuery.prototype.replaceNotInQuery = function () {
  var notInQueryObject = findObjectWithKey(this.restWhere, '$notInQuery');

  if (!notInQueryObject) {
    return;
  } // The notInQuery value must have precisely two keys - where and className


  var notInQueryValue = notInQueryObject['$notInQuery'];

  if (!notInQueryValue.where || !notInQueryValue.className) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $notInQuery');
  }

  const additionalOptions = {
    redirectClassNameForKey: notInQueryValue.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, notInQueryValue.className, notInQueryValue.where, additionalOptions);
  return subquery.execute().then(response => {
    transformNotInQuery(notInQueryObject, subquery.className, response.results); // Recurse to repeat

    return this.replaceNotInQuery();
  });
};

const transformSelect = (selectObject, key, objects) => {
  var values = [];

  for (var result of objects) {
    values.push(key.split('.').reduce((o, i) => o[i], result));
  }

  delete selectObject['$select'];

  if (Array.isArray(selectObject['$in'])) {
    selectObject['$in'] = selectObject['$in'].concat(values);
  } else {
    selectObject['$in'] = values;
  }
}; // Replaces a $select clause by running the subquery, if there is a
// $select clause.
// The $select clause turns into an $in with values selected out of
// the subquery.
// Returns a possible-promise.


RestQuery.prototype.replaceSelect = function () {
  var selectObject = findObjectWithKey(this.restWhere, '$select');

  if (!selectObject) {
    return;
  } // The select value must have precisely two keys - query and key


  var selectValue = selectObject['$select']; // iOS SDK don't send where if not set, let it pass

  if (!selectValue.query || !selectValue.key || typeof selectValue.query !== 'object' || !selectValue.query.className || Object.keys(selectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $select');
  }

  const additionalOptions = {
    redirectClassNameForKey: selectValue.query.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, selectValue.query.className, selectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformSelect(selectObject, selectValue.key, response.results); // Keep replacing $select clauses

    return this.replaceSelect();
  });
};

const transformDontSelect = (dontSelectObject, key, objects) => {
  var values = [];

  for (var result of objects) {
    values.push(key.split('.').reduce((o, i) => o[i], result));
  }

  delete dontSelectObject['$dontSelect'];

  if (Array.isArray(dontSelectObject['$nin'])) {
    dontSelectObject['$nin'] = dontSelectObject['$nin'].concat(values);
  } else {
    dontSelectObject['$nin'] = values;
  }
}; // Replaces a $dontSelect clause by running the subquery, if there is a
// $dontSelect clause.
// The $dontSelect clause turns into an $nin with values selected out of
// the subquery.
// Returns a possible-promise.


RestQuery.prototype.replaceDontSelect = function () {
  var dontSelectObject = findObjectWithKey(this.restWhere, '$dontSelect');

  if (!dontSelectObject) {
    return;
  } // The dontSelect value must have precisely two keys - query and key


  var dontSelectValue = dontSelectObject['$dontSelect'];

  if (!dontSelectValue.query || !dontSelectValue.key || typeof dontSelectValue.query !== 'object' || !dontSelectValue.query.className || Object.keys(dontSelectValue).length !== 2) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'improper usage of $dontSelect');
  }

  const additionalOptions = {
    redirectClassNameForKey: dontSelectValue.query.redirectClassNameForKey
  };

  if (this.restOptions.subqueryReadPreference) {
    additionalOptions.readPreference = this.restOptions.subqueryReadPreference;
    additionalOptions.subqueryReadPreference = this.restOptions.subqueryReadPreference;
  }

  var subquery = new RestQuery(this.config, this.auth, dontSelectValue.query.className, dontSelectValue.query.where, additionalOptions);
  return subquery.execute().then(response => {
    transformDontSelect(dontSelectObject, dontSelectValue.key, response.results); // Keep replacing $dontSelect clauses

    return this.replaceDontSelect();
  });
};

const cleanResultOfSensitiveUserInfo = function (result, auth, config) {
  delete result.password;

  if (auth.isMaster || auth.user && auth.user.id === result.objectId) {
    return;
  }

  for (const field of config.userSensitiveFields) {
    delete result[field];
  }
};

const cleanResultAuthData = function (result) {
  if (result.authData) {
    Object.keys(result.authData).forEach(provider => {
      if (result.authData[provider] === null) {
        delete result.authData[provider];
      }
    });

    if (Object.keys(result.authData).length == 0) {
      delete result.authData;
    }
  }
};

const replaceEqualityConstraint = constraint => {
  if (typeof constraint !== 'object') {
    return constraint;
  }

  const equalToObject = {};
  let hasDirectConstraint = false;
  let hasOperatorConstraint = false;

  for (const key in constraint) {
    if (key.indexOf('$') !== 0) {
      hasDirectConstraint = true;
      equalToObject[key] = constraint[key];
    } else {
      hasOperatorConstraint = true;
    }
  }

  if (hasDirectConstraint && hasOperatorConstraint) {
    constraint['$eq'] = equalToObject;
    Object.keys(equalToObject).forEach(key => {
      delete constraint[key];
    });
  }

  return constraint;
};

RestQuery.prototype.replaceEquality = function () {
  if (typeof this.restWhere !== 'object') {
    return;
  }

  for (const key in this.restWhere) {
    this.restWhere[key] = replaceEqualityConstraint(this.restWhere[key]);
  }
}; // Returns a promise for whether it was successful.
// Populates this.response with an object that only has 'results'.


RestQuery.prototype.runFind = function (options = {}) {
  if (this.findOptions.limit === 0) {
    this.response = {
      results: []
    };
    return Promise.resolve();
  }

  const findOptions = Object.assign({}, this.findOptions);

  if (this.keys) {
    findOptions.keys = this.keys.map(key => {
      return key.split('.')[0];
    });
  }

  if (options.op) {
    findOptions.op = options.op;
  }

  return this.config.database.find(this.className, this.restWhere, findOptions).then(results => {
    if (this.className === '_User') {
      for (var result of results) {
        cleanResultOfSensitiveUserInfo(result, this.auth, this.config);
        cleanResultAuthData(result);
      }
    }

    this.config.filesController.expandFilesInObject(this.config, results);

    if (this.redirectClassName) {
      for (var r of results) {
        r.className = this.redirectClassName;
      }
    }

    this.response = {
      results: results
    };
  });
}; // Returns a promise for whether it was successful.
// Populates this.response.count with the count


RestQuery.prototype.runCount = function () {
  if (!this.doCount) {
    return;
  }

  this.findOptions.count = true;
  delete this.findOptions.skip;
  delete this.findOptions.limit;
  return this.config.database.find(this.className, this.restWhere, this.findOptions).then(c => {
    this.response.count = c;
  });
}; // Augments this.response with all pointers on an object


RestQuery.prototype.handleIncludeAll = function () {
  if (!this.includeAll) {
    return;
  }

  return this.config.database.loadSchema().then(schemaController => schemaController.getOneSchema(this.className)).then(schema => {
    const includeFields = [];
    const keyFields = [];

    for (const field in schema.fields) {
      if (schema.fields[field].type && schema.fields[field].type === 'Pointer') {
        includeFields.push([field]);
        keyFields.push(field);
      }
    } // Add fields to include, keys, remove dups


    this.include = [...new Set([...this.include, ...includeFields])]; // if this.keys not set, then all keys are already included

    if (this.keys) {
      this.keys = [...new Set([...this.keys, ...keyFields])];
    }
  });
}; // Augments this.response with data at the paths provided in this.include.


RestQuery.prototype.handleInclude = function () {
  if (this.include.length == 0) {
    return;
  }

  var pathResponse = includePath(this.config, this.auth, this.response, this.include[0], this.restOptions);

  if (pathResponse.then) {
    return pathResponse.then(newResponse => {
      this.response = newResponse;
      this.include = this.include.slice(1);
      return this.handleInclude();
    });
  } else if (this.include.length > 0) {
    this.include = this.include.slice(1);
    return this.handleInclude();
  }

  return pathResponse;
}; //Returns a promise of a processed set of results


RestQuery.prototype.runAfterFindTrigger = function () {
  if (!this.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'afterFind' trigger for this class.


  const hasAfterFindHook = triggers.triggerExists(this.className, triggers.Types.afterFind, this.config.applicationId);

  if (!hasAfterFindHook) {
    return Promise.resolve();
  } // Skip Aggregate and Distinct Queries


  if (this.findOptions.pipeline || this.findOptions.distinct) {
    return Promise.resolve();
  } // Run afterFind trigger and set the new results


  return triggers.maybeRunAfterFindTrigger(triggers.Types.afterFind, this.auth, this.className, this.response.results, this.config).then(results => {
    // Ensure we properly set the className back
    if (this.redirectClassName) {
      this.response.results = results.map(object => {
        if (object instanceof Parse.Object) {
          object = object.toJSON();
        }

        object.className = this.redirectClassName;
        return object;
      });
    } else {
      this.response.results = results;
    }
  });
}; // Adds included values to the response.
// Path is a list of field names.
// Returns a promise for an augmented response.


function includePath(config, auth, response, path, restOptions = {}) {
  var pointers = findPointers(response.results, path);

  if (pointers.length == 0) {
    return response;
  }

  const pointersHash = {};

  for (var pointer of pointers) {
    if (!pointer) {
      continue;
    }

    const className = pointer.className; // only include the good pointers

    if (className) {
      pointersHash[className] = pointersHash[className] || new Set();
      pointersHash[className].add(pointer.objectId);
    }
  }

  const includeRestOptions = {};

  if (restOptions.keys) {
    const keys = new Set(restOptions.keys.split(','));
    const keySet = Array.from(keys).reduce((set, key) => {
      const keyPath = key.split('.');
      let i = 0;

      for (i; i < path.length; i++) {
        if (path[i] != keyPath[i]) {
          return set;
        }
      }

      if (i < keyPath.length) {
        set.add(keyPath[i]);
      }

      return set;
    }, new Set());

    if (keySet.size > 0) {
      includeRestOptions.keys = Array.from(keySet).join(',');
    }
  }

  if (restOptions.includeReadPreference) {
    includeRestOptions.readPreference = restOptions.includeReadPreference;
    includeRestOptions.includeReadPreference = restOptions.includeReadPreference;
  }

  const queryPromises = Object.keys(pointersHash).map(className => {
    const objectIds = Array.from(pointersHash[className]);
    let where;

    if (objectIds.length === 1) {
      where = {
        objectId: objectIds[0]
      };
    } else {
      where = {
        objectId: {
          $in: objectIds
        }
      };
    }

    var query = new RestQuery(config, auth, className, where, includeRestOptions);
    return query.execute({
      op: 'get'
    }).then(results => {
      results.className = className;
      return Promise.resolve(results);
    });
  }); // Get the objects for all these object ids

  return Promise.all(queryPromises).then(responses => {
    var replace = responses.reduce((replace, includeResponse) => {
      for (var obj of includeResponse.results) {
        obj.__type = 'Object';
        obj.className = includeResponse.className;

        if (obj.className == '_User' && !auth.isMaster) {
          delete obj.sessionToken;
          delete obj.authData;
        }

        replace[obj.objectId] = obj;
      }

      return replace;
    }, {});
    var resp = {
      results: replacePointers(response.results, path, replace)
    };

    if (response.count) {
      resp.count = response.count;
    }

    return resp;
  });
} // Object may be a list of REST-format object to find pointers in, or
// it may be a single object.
// If the path yields things that aren't pointers, this throws an error.
// Path is a list of fields to search into.
// Returns a list of pointers in REST format.


function findPointers(object, path) {
  if (object instanceof Array) {
    var answer = [];

    for (var x of object) {
      answer = answer.concat(findPointers(x, path));
    }

    return answer;
  }

  if (typeof object !== 'object' || !object) {
    return [];
  }

  if (path.length == 0) {
    if (object === null || object.__type == 'Pointer') {
      return [object];
    }

    return [];
  }

  var subobject = object[path[0]];

  if (!subobject) {
    return [];
  }

  return findPointers(subobject, path.slice(1));
} // Object may be a list of REST-format objects to replace pointers
// in, or it may be a single object.
// Path is a list of fields to search into.
// replace is a map from object id -> object.
// Returns something analogous to object, but with the appropriate
// pointers inflated.


function replacePointers(object, path, replace) {
  if (object instanceof Array) {
    return object.map(obj => replacePointers(obj, path, replace)).filter(obj => typeof obj !== 'undefined');
  }

  if (typeof object !== 'object' || !object) {
    return object;
  }

  if (path.length === 0) {
    if (object && object.__type === 'Pointer') {
      return replace[object.objectId];
    }

    return object;
  }

  var subobject = object[path[0]];

  if (!subobject) {
    return object;
  }

  var newsub = replacePointers(subobject, path.slice(1), replace);
  var answer = {};

  for (var key in object) {
    if (key == path[0]) {
      answer[key] = newsub;
    } else {
      answer[key] = object[key];
    }
  }

  return answer;
} // Finds a subobject that has the given key, if there is one.
// Returns undefined otherwise.


function findObjectWithKey(root, key) {
  if (typeof root !== 'object') {
    return;
  }

  if (root instanceof Array) {
    for (var item of root) {
      const answer = findObjectWithKey(item, key);

      if (answer) {
        return answer;
      }
    }
  }

  if (root && root[key]) {
    return root;
  }

  for (var subkey in root) {
    const answer = findObjectWithKey(root[subkey], key);

    if (answer) {
      return answer;
    }
  }
}

module.exports = RestQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0UXVlcnkuanMiXSwibmFtZXMiOlsiU2NoZW1hQ29udHJvbGxlciIsInJlcXVpcmUiLCJQYXJzZSIsInRyaWdnZXJzIiwiY29udGludWVXaGlsZSIsIkFsd2F5c1NlbGVjdGVkS2V5cyIsIlJlc3RRdWVyeSIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJyZXN0V2hlcmUiLCJyZXN0T3B0aW9ucyIsImNsaWVudFNESyIsInJlc3BvbnNlIiwiZmluZE9wdGlvbnMiLCJpc01hc3RlciIsInVzZXIiLCJFcnJvciIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIiRhbmQiLCJfX3R5cGUiLCJvYmplY3RJZCIsImlkIiwiZG9Db3VudCIsImluY2x1ZGVBbGwiLCJpbmNsdWRlIiwiaGFzT3duUHJvcGVydHkiLCJrZXlzRm9ySW5jbHVkZSIsImtleXMiLCJzcGxpdCIsImZpbHRlciIsImtleSIsImxlbmd0aCIsIm1hcCIsInNsaWNlIiwibGFzdEluZGV4T2YiLCJqb2luIiwib3B0aW9uIiwiY29uY2F0IiwiQXJyYXkiLCJmcm9tIiwiU2V0IiwiZmllbGRzIiwib3JkZXIiLCJzb3J0IiwicmVkdWNlIiwic29ydE1hcCIsImZpZWxkIiwidHJpbSIsInNjb3JlIiwiJG1ldGEiLCJwYXRocyIsImluY2x1ZGVzIiwicGF0aFNldCIsIm1lbW8iLCJwYXRoIiwiaW5kZXgiLCJwYXJ0cyIsIk9iamVjdCIsInMiLCJhIiwiYiIsInJlZGlyZWN0S2V5IiwicmVkaXJlY3RDbGFzc05hbWVGb3JLZXkiLCJyZWRpcmVjdENsYXNzTmFtZSIsIklOVkFMSURfSlNPTiIsInByb3RvdHlwZSIsImV4ZWN1dGUiLCJleGVjdXRlT3B0aW9ucyIsIlByb21pc2UiLCJyZXNvbHZlIiwidGhlbiIsImJ1aWxkUmVzdFdoZXJlIiwiaGFuZGxlSW5jbHVkZUFsbCIsInJ1bkZpbmQiLCJydW5Db3VudCIsImhhbmRsZUluY2x1ZGUiLCJydW5BZnRlckZpbmRUcmlnZ2VyIiwiZWFjaCIsImNhbGxiYWNrIiwibGltaXQiLCJmaW5pc2hlZCIsInF1ZXJ5IiwicmVzdWx0cyIsImZvckVhY2giLCJhc3NpZ24iLCIkZ3QiLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsInJlcGxhY2VTZWxlY3QiLCJyZXBsYWNlRG9udFNlbGVjdCIsInJlcGxhY2VJblF1ZXJ5IiwicmVwbGFjZU5vdEluUXVlcnkiLCJyZXBsYWNlRXF1YWxpdHkiLCJhY2wiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImRhdGFiYXNlIiwibmV3Q2xhc3NOYW1lIiwiYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwic3lzdGVtQ2xhc3NlcyIsImluZGV4T2YiLCJsb2FkU2NoZW1hIiwic2NoZW1hQ29udHJvbGxlciIsImhhc0NsYXNzIiwiT1BFUkFUSU9OX0ZPUkJJRERFTiIsInRyYW5zZm9ybUluUXVlcnkiLCJpblF1ZXJ5T2JqZWN0IiwidmFsdWVzIiwicmVzdWx0IiwicHVzaCIsImlzQXJyYXkiLCJmaW5kT2JqZWN0V2l0aEtleSIsImluUXVlcnlWYWx1ZSIsIndoZXJlIiwiSU5WQUxJRF9RVUVSWSIsImFkZGl0aW9uYWxPcHRpb25zIiwic3VicXVlcnlSZWFkUHJlZmVyZW5jZSIsInJlYWRQcmVmZXJlbmNlIiwic3VicXVlcnkiLCJ0cmFuc2Zvcm1Ob3RJblF1ZXJ5Iiwibm90SW5RdWVyeU9iamVjdCIsIm5vdEluUXVlcnlWYWx1ZSIsInRyYW5zZm9ybVNlbGVjdCIsInNlbGVjdE9iamVjdCIsIm9iamVjdHMiLCJvIiwiaSIsInNlbGVjdFZhbHVlIiwidHJhbnNmb3JtRG9udFNlbGVjdCIsImRvbnRTZWxlY3RPYmplY3QiLCJkb250U2VsZWN0VmFsdWUiLCJjbGVhblJlc3VsdE9mU2Vuc2l0aXZlVXNlckluZm8iLCJwYXNzd29yZCIsInVzZXJTZW5zaXRpdmVGaWVsZHMiLCJjbGVhblJlc3VsdEF1dGhEYXRhIiwiYXV0aERhdGEiLCJwcm92aWRlciIsInJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQiLCJjb25zdHJhaW50IiwiZXF1YWxUb09iamVjdCIsImhhc0RpcmVjdENvbnN0cmFpbnQiLCJoYXNPcGVyYXRvckNvbnN0cmFpbnQiLCJvcHRpb25zIiwib3AiLCJmaW5kIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsInIiLCJjb3VudCIsInNraXAiLCJjIiwiZ2V0T25lU2NoZW1hIiwic2NoZW1hIiwiaW5jbHVkZUZpZWxkcyIsImtleUZpZWxkcyIsInR5cGUiLCJwYXRoUmVzcG9uc2UiLCJpbmNsdWRlUGF0aCIsIm5ld1Jlc3BvbnNlIiwiaGFzQWZ0ZXJGaW5kSG9vayIsInRyaWdnZXJFeGlzdHMiLCJUeXBlcyIsImFmdGVyRmluZCIsImFwcGxpY2F0aW9uSWQiLCJwaXBlbGluZSIsImRpc3RpbmN0IiwibWF5YmVSdW5BZnRlckZpbmRUcmlnZ2VyIiwib2JqZWN0IiwidG9KU09OIiwicG9pbnRlcnMiLCJmaW5kUG9pbnRlcnMiLCJwb2ludGVyc0hhc2giLCJwb2ludGVyIiwiYWRkIiwiaW5jbHVkZVJlc3RPcHRpb25zIiwia2V5U2V0Iiwic2V0Iiwia2V5UGF0aCIsInNpemUiLCJpbmNsdWRlUmVhZFByZWZlcmVuY2UiLCJxdWVyeVByb21pc2VzIiwib2JqZWN0SWRzIiwiJGluIiwiYWxsIiwicmVzcG9uc2VzIiwicmVwbGFjZSIsImluY2x1ZGVSZXNwb25zZSIsIm9iaiIsInNlc3Npb25Ub2tlbiIsInJlc3AiLCJyZXBsYWNlUG9pbnRlcnMiLCJhbnN3ZXIiLCJ4Iiwic3Vib2JqZWN0IiwibmV3c3ViIiwicm9vdCIsIml0ZW0iLCJzdWJrZXkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBO0FBQ0E7QUFFQSxJQUFJQSxnQkFBZ0IsR0FBR0MsT0FBTyxDQUFDLGdDQUFELENBQTlCOztBQUNBLElBQUlDLEtBQUssR0FBR0QsT0FBTyxDQUFDLFlBQUQsQ0FBUCxDQUFzQkMsS0FBbEM7O0FBQ0EsTUFBTUMsUUFBUSxHQUFHRixP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Q0EsVUFBSWlLLE1BQUosRUFBWTtBQUNWLGVBQU9BLE1BQVA7QUFDRDtBQUNGO0FBQ0Y7O0FBQ0QsTUFBSUksSUFBSSxJQUFJQSxJQUFJLENBQUNySyxHQUFELENBQWhCLEVBQXVCO0FBQ3JCLFdBQU9xSyxJQUFQO0FBQ0Q7O0FBQ0QsT0FBSyxJQUFJRSxNQUFULElBQW1CRixJQUFuQixFQUF5QjtBQUN2QixVQUFNSixNQUFNLEdBQUdoRixpQkFBaUIsQ0FBQ29GLElBQUksQ0FBQ0UsTUFBRCxDQUFMLEVBQWV2SyxHQUFmLENBQWhDOztBQUNBLFFBQUlpSyxNQUFKLEVBQVk7QUFDVixhQUFPQSxNQUFQO0FBQ0Q7QUFDRjtBQUNGOztBQUVETyxNQUFNLENBQUNDLE9BQVAsR0FBaUJsTSxTQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi8vIEFuIG9iamVjdCB0aGF0IGVuY2Fwc3VsYXRlcyBldmVyeXRoaW5nIHdlIG5lZWQgdG8gcnVuIGEgJ2ZpbmQnXG4vLyBvcGVyYXRpb24sIGVuY29kZWQgaW4gdGhlIFJFU1QgQVBJIGZvcm1hdC5cblxudmFyIFNjaGVtYUNvbnRyb2xsZXIgPSByZXF1aXJlKCcuL0NvbnRyb2xsZXJzL1NjaGVtYUNvbnRyb2xsZXInKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZTtcbmNvbnN0IHRyaWdnZXJzID0gcmVxdWlyZSgnLi90cmlnZ2VycycpO1xuY29uc3QgeyBjb250aW51ZVdoaWxlIH0gPSByZXF1aXJlKCdwYXJzZS9saWIvbm9kZS9wcm9taXNlVXRpbHMnKTtcbmNvbnN0IEFsd2F5c1NlbGVjdGVkS2V5cyA9IFsnb2JqZWN0SWQnLCAnY3JlYXRlZEF0JywgJ3VwZGF0ZWRBdCcsICdBQ0wnXTtcbi8vIHJlc3RPcHRpb25zIGNhbiBpbmNsdWRlOlxuLy8gICBza2lwXG4vLyAgIGxpbWl0XG4vLyAgIG9yZGVyXG4vLyAgIGNvdW50XG4vLyAgIGluY2x1ZGVcbi8vICAga2V5c1xuLy8gICByZWRpcmVjdENsYXNzTmFtZUZvcktleVxuZnVuY3Rpb24gUmVzdFF1ZXJ5KFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgcmVzdFdoZXJlID0ge30sXG4gIHJlc3RPcHRpb25zID0ge30sXG4gIGNsaWVudFNES1xuKSB7XG4gIHRoaXMuY29uZmlnID0gY29uZmlnO1xuICB0aGlzLmF1dGggPSBhdXRoO1xuICB0aGlzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgdGhpcy5yZXN0V2hlcmUgPSByZXN0V2hlcmU7XG4gIHRoaXMucmVzdE9wdGlvbnMgPSByZXN0T3B0aW9ucztcbiAgdGhpcy5jbGllbnRTREsgPSBjbGllbnRTREs7XG4gIHRoaXMucmVzcG9uc2UgPSBudWxsO1xuICB0aGlzLmZpbmRPcHRpb25zID0ge307XG5cbiAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICBpZiAodGhpcy5jbGFzc05hbWUgPT0gJ19TZXNzaW9uJykge1xuICAgICAgaWYgKCF0aGlzLmF1dGgudXNlcikge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLFxuICAgICAgICAgICdJbnZhbGlkIHNlc3Npb24gdG9rZW4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICB0aGlzLnJlc3RXaGVyZSA9IHtcbiAgICAgICAgJGFuZDogW1xuICAgICAgICAgIHRoaXMucmVzdFdoZXJlLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHVzZXI6IHtcbiAgICAgICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IHRoaXMuYXV0aC51c2VyLmlkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICB0aGlzLmRvQ291bnQgPSBmYWxzZTtcbiAgdGhpcy5pbmNsdWRlQWxsID0gZmFsc2U7XG5cbiAgLy8gVGhlIGZvcm1hdCBmb3IgdGhpcy5pbmNsdWRlIGlzIG5vdCB0aGUgc2FtZSBhcyB0aGUgZm9ybWF0IGZvciB0aGVcbiAgLy8gaW5jbHVkZSBvcHRpb24gLSBpdCdzIHRoZSBwYXRocyB3ZSBzaG91bGQgaW5jbHVkZSwgaW4gb3JkZXIsXG4gIC8vIHN0b3JlZCBhcyBhcnJheXMsIHRha2luZyBpbnRvIGFjY291bnQgdGhhdCB3ZSBuZWVkIHRvIGluY2x1ZGUgZm9vXG4gIC8vIGJlZm9yZSBpbmNsdWRpbmcgZm9vLmJhci4gQWxzbyBpdCBzaG91bGQgZGVkdXBlLlxuICAvLyBGb3IgZXhhbXBsZSwgcGFzc2luZyBhbiBhcmcgb2YgaW5jbHVkZT1mb28uYmFyLGZvby5iYXogY291bGQgbGVhZCB0b1xuICAvLyB0aGlzLmluY2x1ZGUgPSBbWydmb28nXSwgWydmb28nLCAnYmF6J10sIFsnZm9vJywgJ2JhciddXVxuICB0aGlzLmluY2x1ZGUgPSBbXTtcblxuICAvLyBJZiB3ZSBoYXZlIGtleXMsIHdlIHByb2JhYmx5IHdhbnQgdG8gZm9yY2Ugc29tZSBpbmNsdWRlcyAobi0xIGxldmVsKVxuICAvLyBTZWUgaXNzdWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy8zMTg1XG4gIGlmIChyZXN0T3B0aW9ucy5oYXNPd25Qcm9wZXJ0eSgna2V5cycpKSB7XG4gICAgY29uc3Qga2V5c0ZvckluY2x1ZGUgPSByZXN0T3B0aW9ucy5rZXlzXG4gICAgICAuc3BsaXQoJywnKVxuICAgICAgLmZpbHRlcihrZXkgPT4ge1xuICAgICAgICAvLyBBdCBsZWFzdCAyIGNvbXBvbmVudHNcbiAgICAgICAgcmV0dXJuIGtleS5zcGxpdCgnLicpLmxlbmd0aCA+IDE7XG4gICAgICB9KVxuICAgICAgLm1hcChrZXkgPT4ge1xuICAgICAgICAvLyBTbGljZSB0aGUgbGFzdCBjb21wb25lbnQgKGEuYi5jIC0+IGEuYilcbiAgICAgICAgLy8gT3RoZXJ3aXNlIHdlJ2xsIGluY2x1ZGUgb25lIGxldmVsIHRvbyBtdWNoLlxuICAgICAgICByZXR1cm4ga2V5LnNsaWNlKDAsIGtleS5sYXN0SW5kZXhPZignLicpKTtcbiAgICAgIH0pXG4gICAgICAuam9pbignLCcpO1xuXG4gICAgLy8gQ29uY2F0IHRoZSBwb3NzaWJseSBwcmVzZW50IGluY2x1ZGUgc3RyaW5nIHdpdGggdGhlIG9uZSBmcm9tIHRoZSBrZXlzXG4gICAgLy8gRGVkdXAgLyBzb3J0aW5nIGlzIGhhbmRsZSBpbiAnaW5jbHVkZScgY2FzZS5cbiAgICBpZiAoa2V5c0ZvckluY2x1ZGUubGVuZ3RoID4gMCkge1xuICAgICAgaWYgKCFyZXN0T3B0aW9ucy5pbmNsdWRlIHx8IHJlc3RPcHRpb25zLmluY2x1ZGUubGVuZ3RoID09IDApIHtcbiAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSA9IGtleXNGb3JJbmNsdWRlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVzdE9wdGlvbnMuaW5jbHVkZSArPSAnLCcgKyBrZXlzRm9ySW5jbHVkZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmb3IgKHZhciBvcHRpb24gaW4gcmVzdE9wdGlvbnMpIHtcbiAgICBzd2l0Y2ggKG9wdGlvbikge1xuICAgICAgY2FzZSAna2V5cyc6IHtcbiAgICAgICAgY29uc3Qga2V5cyA9IHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKS5jb25jYXQoQWx3YXlzU2VsZWN0ZWRLZXlzKTtcbiAgICAgICAgdGhpcy5rZXlzID0gQXJyYXkuZnJvbShuZXcgU2V0KGtleXMpKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjYXNlICdjb3VudCc6XG4gICAgICAgIHRoaXMuZG9Db3VudCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnaW5jbHVkZUFsbCc6XG4gICAgICAgIHRoaXMuaW5jbHVkZUFsbCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZGlzdGluY3QnOlxuICAgICAgY2FzZSAncGlwZWxpbmUnOlxuICAgICAgY2FzZSAnc2tpcCc6XG4gICAgICBjYXNlICdsaW1pdCc6XG4gICAgICBjYXNlICdyZWFkUHJlZmVyZW5jZSc6XG4gICAgICAgIHRoaXMuZmluZE9wdGlvbnNbb3B0aW9uXSA9IHJlc3RPcHRpb25zW29wdGlvbl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnb3JkZXInOlxuICAgICAgICB2YXIgZmllbGRzID0gcmVzdE9wdGlvbnMub3JkZXIuc3BsaXQoJywnKTtcbiAgICAgICAgdGhpcy5maW5kT3B0aW9ucy5zb3J0ID0gZmllbGRzLnJlZHVjZSgoc29ydE1hcCwgZmllbGQpID0+IHtcbiAgICAgICAgICBmaWVsZCA9IGZpZWxkLnRyaW0oKTtcbiAgICAgICAgICBpZiAoZmllbGQgPT09ICckc2NvcmUnKSB7XG4gICAgICAgICAgICBzb3J0TWFwLnNjb3JlID0geyAkbWV0YTogJ3RleHRTY29yZScgfTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkWzBdID09ICctJykge1xuICAgICAgICAgICAgc29ydE1hcFtmaWVsZC5zbGljZSgxKV0gPSAtMTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc29ydE1hcFtmaWVsZF0gPSAxO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gc29ydE1hcDtcbiAgICAgICAgfSwge30pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2luY2x1ZGUnOiB7XG4gICAgICAgIGNvbnN0IHBhdGhzID0gcmVzdE9wdGlvbnMuaW5jbHVkZS5zcGxpdCgnLCcpO1xuICAgICAgICBpZiAocGF0aHMuaW5jbHVkZXMoJyonKSkge1xuICAgICAgICAgIHRoaXMuaW5jbHVkZUFsbCA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgLy8gTG9hZCB0aGUgZXhpc3RpbmcgaW5jbHVkZXMgKGZyb20ga2V5cylcbiAgICAgICAgY29uc3QgcGF0aFNldCA9IHBhdGhzLnJlZHVjZSgobWVtbywgcGF0aCkgPT4ge1xuICAgICAgICAgIC8vIFNwbGl0IGVhY2ggcGF0aHMgb24gLiAoYS5iLmMgLT4gW2EsYixjXSlcbiAgICAgICAgICAvLyByZWR1Y2UgdG8gY3JlYXRlIGFsbCBwYXRoc1xuICAgICAgICAgIC8vIChbYSxiLGNdIC0+IHthOiB0cnVlLCAnYS5iJzogdHJ1ZSwgJ2EuYi5jJzogdHJ1ZX0pXG4gICAgICAgICAgcmV0dXJuIHBhdGguc3BsaXQoJy4nKS5yZWR1Y2UoKG1lbW8sIHBhdGgsIGluZGV4LCBwYXJ0cykgPT4ge1xuICAgICAgICAgICAgbWVtb1twYXJ0cy5zbGljZSgwLCBpbmRleCArIDEpLmpvaW4oJy4nKV0gPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICAgICAgfSwgbWVtbyk7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICB0aGlzLmluY2x1ZGUgPSBPYmplY3Qua2V5cyhwYXRoU2V0KVxuICAgICAgICAgIC5tYXAocyA9PiB7XG4gICAgICAgICAgICByZXR1cm4gcy5zcGxpdCgnLicpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBhLmxlbmd0aCAtIGIubGVuZ3RoOyAvLyBTb3J0IGJ5IG51bWJlciBvZiBjb21wb25lbnRzXG4gICAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAncmVkaXJlY3RDbGFzc05hbWVGb3JLZXknOlxuICAgICAgICB0aGlzLnJlZGlyZWN0S2V5ID0gcmVzdE9wdGlvbnMucmVkaXJlY3RDbGFzc05hbWVGb3JLZXk7XG4gICAgICAgIHRoaXMucmVkaXJlY3RDbGFzc05hbWUgPSBudWxsO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2luY2x1ZGVSZWFkUHJlZmVyZW5jZSc6XG4gICAgICBjYXNlICdzdWJxdWVyeVJlYWRQcmVmZXJlbmNlJzpcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICdiYWQgb3B0aW9uOiAnICsgb3B0aW9uXG4gICAgICAgICk7XG4gICAgfVxuICB9XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgYSBxdWVyeVxuLy8gaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgdGhlIHJlc3BvbnNlIC0gYW4gb2JqZWN0IHdpdGggb3B0aW9uYWwga2V5c1xuLy8gJ3Jlc3VsdHMnIGFuZCAnY291bnQnLlxuLy8gVE9ETzogY29uc29saWRhdGUgdGhlIHJlcGxhY2VYIGZ1bmN0aW9uc1xuUmVzdFF1ZXJ5LnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24oZXhlY3V0ZU9wdGlvbnMpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuYnVpbGRSZXN0V2hlcmUoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGVBbGwoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkZpbmQoZXhlY3V0ZU9wdGlvbnMpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQ291bnQoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGUoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkFmdGVyRmluZFRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlc3BvbnNlO1xuICAgIH0pO1xufTtcblxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5lYWNoID0gZnVuY3Rpb24oY2FsbGJhY2spIHtcbiAgY29uc3QgeyBjb25maWcsIGF1dGgsIGNsYXNzTmFtZSwgcmVzdFdoZXJlLCByZXN0T3B0aW9ucywgY2xpZW50U0RLIH0gPSB0aGlzO1xuICAvLyBpZiB0aGUgbGltaXQgaXMgc2V0LCB1c2UgaXRcbiAgcmVzdE9wdGlvbnMubGltaXQgPSByZXN0T3B0aW9ucy5saW1pdCB8fCAxMDA7XG4gIHJlc3RPcHRpb25zLm9yZGVyID0gJ29iamVjdElkJztcbiAgbGV0IGZpbmlzaGVkID0gZmFsc2U7XG5cbiAgcmV0dXJuIGNvbnRpbnVlV2hpbGUoXG4gICAgKCkgPT4ge1xuICAgICAgcmV0dXJuICFmaW5pc2hlZDtcbiAgICB9LFxuICAgIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBhdXRoLFxuICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgIHJlc3RXaGVyZSxcbiAgICAgICAgcmVzdE9wdGlvbnMsXG4gICAgICAgIGNsaWVudFNES1xuICAgICAgKTtcbiAgICAgIGNvbnN0IHsgcmVzdWx0cyB9ID0gYXdhaXQgcXVlcnkuZXhlY3V0ZSgpO1xuICAgICAgcmVzdWx0cy5mb3JFYWNoKGNhbGxiYWNrKTtcbiAgICAgIGZpbmlzaGVkID0gcmVzdWx0cy5sZW5ndGggPCByZXN0T3B0aW9ucy5saW1pdDtcbiAgICAgIGlmICghZmluaXNoZWQpIHtcbiAgICAgICAgcmVzdFdoZXJlLm9iamVjdElkID0gT2JqZWN0LmFzc2lnbih7fSwgcmVzdFdoZXJlLm9iamVjdElkLCB7XG4gICAgICAgICAgJGd0OiByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0ub2JqZWN0SWQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgKTtcbn07XG5cblJlc3RRdWVyeS5wcm90b3R5cGUuYnVpbGRSZXN0V2hlcmUgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZ2V0VXNlckFuZFJvbGVBQ0woKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VTZWxlY3QoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VEb250U2VsZWN0KCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXBsYWNlSW5RdWVyeSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucmVwbGFjZU5vdEluUXVlcnkoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJlcGxhY2VFcXVhbGl0eSgpO1xuICAgIH0pO1xufTtcblxuLy8gVXNlcyB0aGUgQXV0aCBvYmplY3QgdG8gZ2V0IHRoZSBsaXN0IG9mIHJvbGVzLCBhZGRzIHRoZSB1c2VyIGlkXG5SZXN0UXVlcnkucHJvdG90eXBlLmdldFVzZXJBbmRSb2xlQUNMID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB0aGlzLmZpbmRPcHRpb25zLmFjbCA9IFsnKiddO1xuXG4gIGlmICh0aGlzLmF1dGgudXNlcikge1xuICAgIHJldHVybiB0aGlzLmF1dGguZ2V0VXNlclJvbGVzKCkudGhlbihyb2xlcyA9PiB7XG4gICAgICB0aGlzLmZpbmRPcHRpb25zLmFjbCA9IHRoaXMuZmluZE9wdGlvbnMuYWNsLmNvbmNhdChyb2xlcywgW1xuICAgICAgICB0aGlzLmF1dGgudXNlci5pZCxcbiAgICAgIF0pO1xuICAgICAgcmV0dXJuO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufTtcblxuLy8gQ2hhbmdlcyB0aGUgY2xhc3NOYW1lIGlmIHJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IGlzIHNldC5cbi8vIFJldHVybnMgYSBwcm9taXNlLlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSA9IGZ1bmN0aW9uKCkge1xuICBpZiAoIXRoaXMucmVkaXJlY3RLZXkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBXZSBuZWVkIHRvIGNoYW5nZSB0aGUgY2xhc3MgbmFtZSBiYXNlZCBvbiB0aGUgc2NoZW1hXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5yZWRpcmVjdENsYXNzTmFtZUZvcktleSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZWRpcmVjdEtleSlcbiAgICAudGhlbihuZXdDbGFzc05hbWUgPT4ge1xuICAgICAgdGhpcy5jbGFzc05hbWUgPSBuZXdDbGFzc05hbWU7XG4gICAgICB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lID0gbmV3Q2xhc3NOYW1lO1xuICAgIH0pO1xufTtcblxuLy8gVmFsaWRhdGVzIHRoaXMgb3BlcmF0aW9uIGFnYWluc3QgdGhlIGFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiBjb25maWcuXG5SZXN0UXVlcnkucHJvdG90eXBlLnZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAoXG4gICAgdGhpcy5jb25maWcuYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uID09PSBmYWxzZSAmJlxuICAgICF0aGlzLmF1dGguaXNNYXN0ZXIgJiZcbiAgICBTY2hlbWFDb250cm9sbGVyLnN5c3RlbUNsYXNzZXMuaW5kZXhPZih0aGlzLmNsYXNzTmFtZSkgPT09IC0xXG4gICkge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmhhc0NsYXNzKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKGhhc0NsYXNzID0+IHtcbiAgICAgICAgaWYgKGhhc0NsYXNzICE9PSB0cnVlKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgICdUaGlzIHVzZXIgaXMgbm90IGFsbG93ZWQgdG8gYWNjZXNzICcgK1xuICAgICAgICAgICAgICAnbm9uLWV4aXN0ZW50IGNsYXNzOiAnICtcbiAgICAgICAgICAgICAgdGhpcy5jbGFzc05hbWVcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbmZ1bmN0aW9uIHRyYW5zZm9ybUluUXVlcnkoaW5RdWVyeU9iamVjdCwgY2xhc3NOYW1lLCByZXN1bHRzKSB7XG4gIHZhciB2YWx1ZXMgPSBbXTtcbiAgZm9yICh2YXIgcmVzdWx0IG9mIHJlc3VsdHMpIHtcbiAgICB2YWx1ZXMucHVzaCh7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogY2xhc3NOYW1lLFxuICAgICAgb2JqZWN0SWQ6IHJlc3VsdC5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBkZWxldGUgaW5RdWVyeU9iamVjdFsnJGluUXVlcnknXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkoaW5RdWVyeU9iamVjdFsnJGluJ10pKSB7XG4gICAgaW5RdWVyeU9iamVjdFsnJGluJ10gPSBpblF1ZXJ5T2JqZWN0WyckaW4nXS5jb25jYXQodmFsdWVzKTtcbiAgfSBlbHNlIHtcbiAgICBpblF1ZXJ5T2JqZWN0WyckaW4nXSA9IHZhbHVlcztcbiAgfVxufVxuXG4vLyBSZXBsYWNlcyBhICRpblF1ZXJ5IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYW5cbi8vICRpblF1ZXJ5IGNsYXVzZS5cbi8vIFRoZSAkaW5RdWVyeSBjbGF1c2UgdHVybnMgaW50byBhbiAkaW4gd2l0aCB2YWx1ZXMgdGhhdCBhcmUganVzdFxuLy8gcG9pbnRlcnMgdG8gdGhlIG9iamVjdHMgcmV0dXJuZWQgaW4gdGhlIHN1YnF1ZXJ5LlxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5yZXBsYWNlSW5RdWVyeSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgaW5RdWVyeU9iamVjdCA9IGZpbmRPYmplY3RXaXRoS2V5KHRoaXMucmVzdFdoZXJlLCAnJGluUXVlcnknKTtcbiAgaWYgKCFpblF1ZXJ5T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIGluUXVlcnkgdmFsdWUgbXVzdCBoYXZlIHByZWNpc2VseSB0d28ga2V5cyAtIHdoZXJlIGFuZCBjbGFzc05hbWVcbiAgdmFyIGluUXVlcnlWYWx1ZSA9IGluUXVlcnlPYmplY3RbJyRpblF1ZXJ5J107XG4gIGlmICghaW5RdWVyeVZhbHVlLndoZXJlIHx8ICFpblF1ZXJ5VmFsdWUuY2xhc3NOYW1lKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICdpbXByb3BlciB1c2FnZSBvZiAkaW5RdWVyeSdcbiAgICApO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IGluUXVlcnlWYWx1ZS5yZWRpcmVjdENsYXNzTmFtZUZvcktleSxcbiAgfTtcblxuICBpZiAodGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlKSB7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSB0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2U7XG4gICAgYWRkaXRpb25hbE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIHZhciBzdWJxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5hdXRoLFxuICAgIGluUXVlcnlWYWx1ZS5jbGFzc05hbWUsXG4gICAgaW5RdWVyeVZhbHVlLndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtSW5RdWVyeShpblF1ZXJ5T2JqZWN0LCBzdWJxdWVyeS5jbGFzc05hbWUsIHJlc3BvbnNlLnJlc3VsdHMpO1xuICAgIC8vIFJlY3Vyc2UgdG8gcmVwZWF0XG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZUluUXVlcnkoKTtcbiAgfSk7XG59O1xuXG5mdW5jdGlvbiB0cmFuc2Zvcm1Ob3RJblF1ZXJ5KG5vdEluUXVlcnlPYmplY3QsIGNsYXNzTmFtZSwgcmVzdWx0cykge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgdmFsdWVzLnB1c2goe1xuICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgIG9iamVjdElkOiByZXN1bHQub2JqZWN0SWQsXG4gICAgfSk7XG4gIH1cbiAgZGVsZXRlIG5vdEluUXVlcnlPYmplY3RbJyRub3RJblF1ZXJ5J107XG4gIGlmIChBcnJheS5pc0FycmF5KG5vdEluUXVlcnlPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10gPSBub3RJblF1ZXJ5T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgbm90SW5RdWVyeU9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59XG5cbi8vIFJlcGxhY2VzIGEgJG5vdEluUXVlcnkgY2xhdXNlIGJ5IHJ1bm5pbmcgdGhlIHN1YnF1ZXJ5LCBpZiB0aGVyZSBpcyBhblxuLy8gJG5vdEluUXVlcnkgY2xhdXNlLlxuLy8gVGhlICRub3RJblF1ZXJ5IGNsYXVzZSB0dXJucyBpbnRvIGEgJG5pbiB3aXRoIHZhbHVlcyB0aGF0IGFyZSBqdXN0XG4vLyBwb2ludGVycyB0byB0aGUgb2JqZWN0cyByZXR1cm5lZCBpbiB0aGUgc3VicXVlcnkuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJlcGxhY2VOb3RJblF1ZXJ5ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBub3RJblF1ZXJ5T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckbm90SW5RdWVyeScpO1xuICBpZiAoIW5vdEluUXVlcnlPYmplY3QpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBUaGUgbm90SW5RdWVyeSB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gd2hlcmUgYW5kIGNsYXNzTmFtZVxuICB2YXIgbm90SW5RdWVyeVZhbHVlID0gbm90SW5RdWVyeU9iamVjdFsnJG5vdEluUXVlcnknXTtcbiAgaWYgKCFub3RJblF1ZXJ5VmFsdWUud2hlcmUgfHwgIW5vdEluUXVlcnlWYWx1ZS5jbGFzc05hbWUpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgJ2ltcHJvcGVyIHVzYWdlIG9mICRub3RJblF1ZXJ5J1xuICAgICk7XG4gIH1cblxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogbm90SW5RdWVyeVZhbHVlLnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgbm90SW5RdWVyeVZhbHVlLmNsYXNzTmFtZSxcbiAgICBub3RJblF1ZXJ5VmFsdWUud2hlcmUsXG4gICAgYWRkaXRpb25hbE9wdGlvbnNcbiAgKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1Ob3RJblF1ZXJ5KG5vdEluUXVlcnlPYmplY3QsIHN1YnF1ZXJ5LmNsYXNzTmFtZSwgcmVzcG9uc2UucmVzdWx0cyk7XG4gICAgLy8gUmVjdXJzZSB0byByZXBlYXRcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlTm90SW5RdWVyeSgpO1xuICB9KTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybVNlbGVjdCA9IChzZWxlY3RPYmplY3QsIGtleSwgb2JqZWN0cykgPT4ge1xuICB2YXIgdmFsdWVzID0gW107XG4gIGZvciAodmFyIHJlc3VsdCBvZiBvYmplY3RzKSB7XG4gICAgdmFsdWVzLnB1c2goa2V5LnNwbGl0KCcuJykucmVkdWNlKChvLCBpKSA9PiBvW2ldLCByZXN1bHQpKTtcbiAgfVxuICBkZWxldGUgc2VsZWN0T2JqZWN0Wyckc2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdE9iamVjdFsnJGluJ10pKSB7XG4gICAgc2VsZWN0T2JqZWN0WyckaW4nXSA9IHNlbGVjdE9iamVjdFsnJGluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgc2VsZWN0T2JqZWN0WyckaW4nXSA9IHZhbHVlcztcbiAgfVxufTtcblxuLy8gUmVwbGFjZXMgYSAkc2VsZWN0IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYVxuLy8gJHNlbGVjdCBjbGF1c2UuXG4vLyBUaGUgJHNlbGVjdCBjbGF1c2UgdHVybnMgaW50byBhbiAkaW4gd2l0aCB2YWx1ZXMgc2VsZWN0ZWQgb3V0IG9mXG4vLyB0aGUgc3VicXVlcnkuXG4vLyBSZXR1cm5zIGEgcG9zc2libGUtcHJvbWlzZS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZVNlbGVjdCA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc2VsZWN0T2JqZWN0ID0gZmluZE9iamVjdFdpdGhLZXkodGhpcy5yZXN0V2hlcmUsICckc2VsZWN0Jyk7XG4gIGlmICghc2VsZWN0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gVGhlIHNlbGVjdCB2YWx1ZSBtdXN0IGhhdmUgcHJlY2lzZWx5IHR3byBrZXlzIC0gcXVlcnkgYW5kIGtleVxuICB2YXIgc2VsZWN0VmFsdWUgPSBzZWxlY3RPYmplY3RbJyRzZWxlY3QnXTtcbiAgLy8gaU9TIFNESyBkb24ndCBzZW5kIHdoZXJlIGlmIG5vdCBzZXQsIGxldCBpdCBwYXNzXG4gIGlmIChcbiAgICAhc2VsZWN0VmFsdWUucXVlcnkgfHxcbiAgICAhc2VsZWN0VmFsdWUua2V5IHx8XG4gICAgdHlwZW9mIHNlbGVjdFZhbHVlLnF1ZXJ5ICE9PSAnb2JqZWN0JyB8fFxuICAgICFzZWxlY3RWYWx1ZS5xdWVyeS5jbGFzc05hbWUgfHxcbiAgICBPYmplY3Qua2V5cyhzZWxlY3RWYWx1ZSkubGVuZ3RoICE9PSAyXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJHNlbGVjdCdcbiAgICApO1xuICB9XG5cbiAgY29uc3QgYWRkaXRpb25hbE9wdGlvbnMgPSB7XG4gICAgcmVkaXJlY3RDbGFzc05hbWVGb3JLZXk6IHNlbGVjdFZhbHVlLnF1ZXJ5LnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgc2VsZWN0VmFsdWUucXVlcnkuY2xhc3NOYW1lLFxuICAgIHNlbGVjdFZhbHVlLnF1ZXJ5LndoZXJlLFxuICAgIGFkZGl0aW9uYWxPcHRpb25zXG4gICk7XG4gIHJldHVybiBzdWJxdWVyeS5leGVjdXRlKCkudGhlbihyZXNwb25zZSA9PiB7XG4gICAgdHJhbnNmb3JtU2VsZWN0KHNlbGVjdE9iamVjdCwgc2VsZWN0VmFsdWUua2V5LCByZXNwb25zZS5yZXN1bHRzKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkc2VsZWN0IGNsYXVzZXNcbiAgICByZXR1cm4gdGhpcy5yZXBsYWNlU2VsZWN0KCk7XG4gIH0pO1xufTtcblxuY29uc3QgdHJhbnNmb3JtRG9udFNlbGVjdCA9IChkb250U2VsZWN0T2JqZWN0LCBrZXksIG9iamVjdHMpID0+IHtcbiAgdmFyIHZhbHVlcyA9IFtdO1xuICBmb3IgKHZhciByZXN1bHQgb2Ygb2JqZWN0cykge1xuICAgIHZhbHVlcy5wdXNoKGtleS5zcGxpdCgnLicpLnJlZHVjZSgobywgaSkgPT4gb1tpXSwgcmVzdWx0KSk7XG4gIH1cbiAgZGVsZXRlIGRvbnRTZWxlY3RPYmplY3RbJyRkb250U2VsZWN0J107XG4gIGlmIChBcnJheS5pc0FycmF5KGRvbnRTZWxlY3RPYmplY3RbJyRuaW4nXSkpIHtcbiAgICBkb250U2VsZWN0T2JqZWN0WyckbmluJ10gPSBkb250U2VsZWN0T2JqZWN0WyckbmluJ10uY29uY2F0KHZhbHVlcyk7XG4gIH0gZWxzZSB7XG4gICAgZG9udFNlbGVjdE9iamVjdFsnJG5pbiddID0gdmFsdWVzO1xuICB9XG59O1xuXG4vLyBSZXBsYWNlcyBhICRkb250U2VsZWN0IGNsYXVzZSBieSBydW5uaW5nIHRoZSBzdWJxdWVyeSwgaWYgdGhlcmUgaXMgYVxuLy8gJGRvbnRTZWxlY3QgY2xhdXNlLlxuLy8gVGhlICRkb250U2VsZWN0IGNsYXVzZSB0dXJucyBpbnRvIGFuICRuaW4gd2l0aCB2YWx1ZXMgc2VsZWN0ZWQgb3V0IG9mXG4vLyB0aGUgc3VicXVlcnkuXG4vLyBSZXR1cm5zIGEgcG9zc2libGUtcHJvbWlzZS5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZURvbnRTZWxlY3QgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGRvbnRTZWxlY3RPYmplY3QgPSBmaW5kT2JqZWN0V2l0aEtleSh0aGlzLnJlc3RXaGVyZSwgJyRkb250U2VsZWN0Jyk7XG4gIGlmICghZG9udFNlbGVjdE9iamVjdCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFRoZSBkb250U2VsZWN0IHZhbHVlIG11c3QgaGF2ZSBwcmVjaXNlbHkgdHdvIGtleXMgLSBxdWVyeSBhbmQga2V5XG4gIHZhciBkb250U2VsZWN0VmFsdWUgPSBkb250U2VsZWN0T2JqZWN0WyckZG9udFNlbGVjdCddO1xuICBpZiAoXG4gICAgIWRvbnRTZWxlY3RWYWx1ZS5xdWVyeSB8fFxuICAgICFkb250U2VsZWN0VmFsdWUua2V5IHx8XG4gICAgdHlwZW9mIGRvbnRTZWxlY3RWYWx1ZS5xdWVyeSAhPT0gJ29iamVjdCcgfHxcbiAgICAhZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSB8fFxuICAgIE9iamVjdC5rZXlzKGRvbnRTZWxlY3RWYWx1ZSkubGVuZ3RoICE9PSAyXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAnaW1wcm9wZXIgdXNhZ2Ugb2YgJGRvbnRTZWxlY3QnXG4gICAgKTtcbiAgfVxuICBjb25zdCBhZGRpdGlvbmFsT3B0aW9ucyA9IHtcbiAgICByZWRpcmVjdENsYXNzTmFtZUZvcktleTogZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LnJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5LFxuICB9O1xuXG4gIGlmICh0aGlzLnJlc3RPcHRpb25zLnN1YnF1ZXJ5UmVhZFByZWZlcmVuY2UpIHtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5yZWFkUHJlZmVyZW5jZSA9IHRoaXMucmVzdE9wdGlvbnMuc3VicXVlcnlSZWFkUHJlZmVyZW5jZTtcbiAgICBhZGRpdGlvbmFsT3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlID0gdGhpcy5yZXN0T3B0aW9ucy5zdWJxdWVyeVJlYWRQcmVmZXJlbmNlO1xuICB9XG5cbiAgdmFyIHN1YnF1ZXJ5ID0gbmV3IFJlc3RRdWVyeShcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgZG9udFNlbGVjdFZhbHVlLnF1ZXJ5LmNsYXNzTmFtZSxcbiAgICBkb250U2VsZWN0VmFsdWUucXVlcnkud2hlcmUsXG4gICAgYWRkaXRpb25hbE9wdGlvbnNcbiAgKTtcbiAgcmV0dXJuIHN1YnF1ZXJ5LmV4ZWN1dGUoKS50aGVuKHJlc3BvbnNlID0+IHtcbiAgICB0cmFuc2Zvcm1Eb250U2VsZWN0KFxuICAgICAgZG9udFNlbGVjdE9iamVjdCxcbiAgICAgIGRvbnRTZWxlY3RWYWx1ZS5rZXksXG4gICAgICByZXNwb25zZS5yZXN1bHRzXG4gICAgKTtcbiAgICAvLyBLZWVwIHJlcGxhY2luZyAkZG9udFNlbGVjdCBjbGF1c2VzXG4gICAgcmV0dXJuIHRoaXMucmVwbGFjZURvbnRTZWxlY3QoKTtcbiAgfSk7XG59O1xuXG5jb25zdCBjbGVhblJlc3VsdE9mU2Vuc2l0aXZlVXNlckluZm8gPSBmdW5jdGlvbihyZXN1bHQsIGF1dGgsIGNvbmZpZykge1xuICBkZWxldGUgcmVzdWx0LnBhc3N3b3JkO1xuXG4gIGlmIChhdXRoLmlzTWFzdGVyIHx8IChhdXRoLnVzZXIgJiYgYXV0aC51c2VyLmlkID09PSByZXN1bHQub2JqZWN0SWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgZm9yIChjb25zdCBmaWVsZCBvZiBjb25maWcudXNlclNlbnNpdGl2ZUZpZWxkcykge1xuICAgIGRlbGV0ZSByZXN1bHRbZmllbGRdO1xuICB9XG59O1xuXG5jb25zdCBjbGVhblJlc3VsdEF1dGhEYXRhID0gZnVuY3Rpb24ocmVzdWx0KSB7XG4gIGlmIChyZXN1bHQuYXV0aERhdGEpIHtcbiAgICBPYmplY3Qua2V5cyhyZXN1bHQuYXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgaWYgKHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl0gPT09IG51bGwpIHtcbiAgICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoT2JqZWN0LmtleXMocmVzdWx0LmF1dGhEYXRhKS5sZW5ndGggPT0gMCkge1xuICAgICAgZGVsZXRlIHJlc3VsdC5hdXRoRGF0YTtcbiAgICB9XG4gIH1cbn07XG5cbmNvbnN0IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQgPSBjb25zdHJhaW50ID0+IHtcbiAgaWYgKHR5cGVvZiBjb25zdHJhaW50ICE9PSAnb2JqZWN0Jykge1xuICAgIHJldHVybiBjb25zdHJhaW50O1xuICB9XG4gIGNvbnN0IGVxdWFsVG9PYmplY3QgPSB7fTtcbiAgbGV0IGhhc0RpcmVjdENvbnN0cmFpbnQgPSBmYWxzZTtcbiAgbGV0IGhhc09wZXJhdG9yQ29uc3RyYWludCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IGtleSBpbiBjb25zdHJhaW50KSB7XG4gICAgaWYgKGtleS5pbmRleE9mKCckJykgIT09IDApIHtcbiAgICAgIGhhc0RpcmVjdENvbnN0cmFpbnQgPSB0cnVlO1xuICAgICAgZXF1YWxUb09iamVjdFtrZXldID0gY29uc3RyYWludFtrZXldO1xuICAgIH0gZWxzZSB7XG4gICAgICBoYXNPcGVyYXRvckNvbnN0cmFpbnQgPSB0cnVlO1xuICAgIH1cbiAgfVxuICBpZiAoaGFzRGlyZWN0Q29uc3RyYWludCAmJiBoYXNPcGVyYXRvckNvbnN0cmFpbnQpIHtcbiAgICBjb25zdHJhaW50WyckZXEnXSA9IGVxdWFsVG9PYmplY3Q7XG4gICAgT2JqZWN0LmtleXMoZXF1YWxUb09iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgZGVsZXRlIGNvbnN0cmFpbnRba2V5XTtcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gY29uc3RyYWludDtcbn07XG5cblJlc3RRdWVyeS5wcm90b3R5cGUucmVwbGFjZUVxdWFsaXR5ID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0eXBlb2YgdGhpcy5yZXN0V2hlcmUgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3Qga2V5IGluIHRoaXMucmVzdFdoZXJlKSB7XG4gICAgdGhpcy5yZXN0V2hlcmVba2V5XSA9IHJlcGxhY2VFcXVhbGl0eUNvbnN0cmFpbnQodGhpcy5yZXN0V2hlcmVba2V5XSk7XG4gIH1cbn07XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGV0aGVyIGl0IHdhcyBzdWNjZXNzZnVsLlxuLy8gUG9wdWxhdGVzIHRoaXMucmVzcG9uc2Ugd2l0aCBhbiBvYmplY3QgdGhhdCBvbmx5IGhhcyAncmVzdWx0cycuXG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkZpbmQgPSBmdW5jdGlvbihvcHRpb25zID0ge30pIHtcbiAgaWYgKHRoaXMuZmluZE9wdGlvbnMubGltaXQgPT09IDApIHtcbiAgICB0aGlzLnJlc3BvbnNlID0geyByZXN1bHRzOiBbXSB9O1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICBjb25zdCBmaW5kT3B0aW9ucyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuZmluZE9wdGlvbnMpO1xuICBpZiAodGhpcy5rZXlzKSB7XG4gICAgZmluZE9wdGlvbnMua2V5cyA9IHRoaXMua2V5cy5tYXAoa2V5ID0+IHtcbiAgICAgIHJldHVybiBrZXkuc3BsaXQoJy4nKVswXTtcbiAgICB9KTtcbiAgfVxuICBpZiAob3B0aW9ucy5vcCkge1xuICAgIGZpbmRPcHRpb25zLm9wID0gb3B0aW9ucy5vcDtcbiAgfVxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZCh0aGlzLmNsYXNzTmFtZSwgdGhpcy5yZXN0V2hlcmUsIGZpbmRPcHRpb25zKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgaWYgKHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgIGZvciAodmFyIHJlc3VsdCBvZiByZXN1bHRzKSB7XG4gICAgICAgICAgY2xlYW5SZXN1bHRPZlNlbnNpdGl2ZVVzZXJJbmZvKHJlc3VsdCwgdGhpcy5hdXRoLCB0aGlzLmNvbmZpZyk7XG4gICAgICAgICAgY2xlYW5SZXN1bHRBdXRoRGF0YShyZXN1bHQpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHRoaXMuY29uZmlnLmZpbGVzQ29udHJvbGxlci5leHBhbmRGaWxlc0luT2JqZWN0KHRoaXMuY29uZmlnLCByZXN1bHRzKTtcblxuICAgICAgaWYgKHRoaXMucmVkaXJlY3RDbGFzc05hbWUpIHtcbiAgICAgICAgZm9yICh2YXIgciBvZiByZXN1bHRzKSB7XG4gICAgICAgICAgci5jbGFzc05hbWUgPSB0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0aGlzLnJlc3BvbnNlID0geyByZXN1bHRzOiByZXN1bHRzIH07XG4gICAgfSk7XG59O1xuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hldGhlciBpdCB3YXMgc3VjY2Vzc2Z1bC5cbi8vIFBvcHVsYXRlcyB0aGlzLnJlc3BvbnNlLmNvdW50IHdpdGggdGhlIGNvdW50XG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkNvdW50ID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5kb0NvdW50KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRoaXMuZmluZE9wdGlvbnMuY291bnQgPSB0cnVlO1xuICBkZWxldGUgdGhpcy5maW5kT3B0aW9ucy5za2lwO1xuICBkZWxldGUgdGhpcy5maW5kT3B0aW9ucy5saW1pdDtcbiAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgLmZpbmQodGhpcy5jbGFzc05hbWUsIHRoaXMucmVzdFdoZXJlLCB0aGlzLmZpbmRPcHRpb25zKVxuICAgIC50aGVuKGMgPT4ge1xuICAgICAgdGhpcy5yZXNwb25zZS5jb3VudCA9IGM7XG4gICAgfSk7XG59O1xuXG4vLyBBdWdtZW50cyB0aGlzLnJlc3BvbnNlIHdpdGggYWxsIHBvaW50ZXJzIG9uIGFuIG9iamVjdFxuUmVzdFF1ZXJ5LnByb3RvdHlwZS5oYW5kbGVJbmNsdWRlQWxsID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5pbmNsdWRlQWxsKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5sb2FkU2NoZW1hKClcbiAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHNjaGVtYUNvbnRyb2xsZXIuZ2V0T25lU2NoZW1hKHRoaXMuY2xhc3NOYW1lKSlcbiAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgY29uc3QgaW5jbHVkZUZpZWxkcyA9IFtdO1xuICAgICAgY29uc3Qga2V5RmllbGRzID0gW107XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHNjaGVtYS5maWVsZHMpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgJiZcbiAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9pbnRlcidcbiAgICAgICAgKSB7XG4gICAgICAgICAgaW5jbHVkZUZpZWxkcy5wdXNoKFtmaWVsZF0pO1xuICAgICAgICAgIGtleUZpZWxkcy5wdXNoKGZpZWxkKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gQWRkIGZpZWxkcyB0byBpbmNsdWRlLCBrZXlzLCByZW1vdmUgZHVwc1xuICAgICAgdGhpcy5pbmNsdWRlID0gWy4uLm5ldyBTZXQoWy4uLnRoaXMuaW5jbHVkZSwgLi4uaW5jbHVkZUZpZWxkc10pXTtcbiAgICAgIC8vIGlmIHRoaXMua2V5cyBub3Qgc2V0LCB0aGVuIGFsbCBrZXlzIGFyZSBhbHJlYWR5IGluY2x1ZGVkXG4gICAgICBpZiAodGhpcy5rZXlzKSB7XG4gICAgICAgIHRoaXMua2V5cyA9IFsuLi5uZXcgU2V0KFsuLi50aGlzLmtleXMsIC4uLmtleUZpZWxkc10pXTtcbiAgICAgIH1cbiAgICB9KTtcbn07XG5cbi8vIEF1Z21lbnRzIHRoaXMucmVzcG9uc2Ugd2l0aCBkYXRhIGF0IHRoZSBwYXRocyBwcm92aWRlZCBpbiB0aGlzLmluY2x1ZGUuXG5SZXN0UXVlcnkucHJvdG90eXBlLmhhbmRsZUluY2x1ZGUgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuaW5jbHVkZS5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHZhciBwYXRoUmVzcG9uc2UgPSBpbmNsdWRlUGF0aChcbiAgICB0aGlzLmNvbmZpZyxcbiAgICB0aGlzLmF1dGgsXG4gICAgdGhpcy5yZXNwb25zZSxcbiAgICB0aGlzLmluY2x1ZGVbMF0sXG4gICAgdGhpcy5yZXN0T3B0aW9uc1xuICApO1xuICBpZiAocGF0aFJlc3BvbnNlLnRoZW4pIHtcbiAgICByZXR1cm4gcGF0aFJlc3BvbnNlLnRoZW4obmV3UmVzcG9uc2UgPT4ge1xuICAgICAgdGhpcy5yZXNwb25zZSA9IG5ld1Jlc3BvbnNlO1xuICAgICAgdGhpcy5pbmNsdWRlID0gdGhpcy5pbmNsdWRlLnNsaWNlKDEpO1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlSW5jbHVkZSgpO1xuICAgIH0pO1xuICB9IGVsc2UgaWYgKHRoaXMuaW5jbHVkZS5sZW5ndGggPiAwKSB7XG4gICAgdGhpcy5pbmNsdWRlID0gdGhpcy5pbmNsdWRlLnNsaWNlKDEpO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZUluY2x1ZGUoKTtcbiAgfVxuXG4gIHJldHVybiBwYXRoUmVzcG9uc2U7XG59O1xuXG4vL1JldHVybnMgYSBwcm9taXNlIG9mIGEgcHJvY2Vzc2VkIHNldCBvZiByZXN1bHRzXG5SZXN0UXVlcnkucHJvdG90eXBlLnJ1bkFmdGVyRmluZFRyaWdnZXIgPSBmdW5jdGlvbigpIHtcbiAgaWYgKCF0aGlzLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyRmluZCcgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJGaW5kSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJGaW5kLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgaWYgKCFoYXNBZnRlckZpbmRIb29rKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIC8vIFNraXAgQWdncmVnYXRlIGFuZCBEaXN0aW5jdCBRdWVyaWVzXG4gIGlmICh0aGlzLmZpbmRPcHRpb25zLnBpcGVsaW5lIHx8IHRoaXMuZmluZE9wdGlvbnMuZGlzdGluY3QpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gUnVuIGFmdGVyRmluZCB0cmlnZ2VyIGFuZCBzZXQgdGhlIG5ldyByZXN1bHRzXG4gIHJldHVybiB0cmlnZ2Vyc1xuICAgIC5tYXliZVJ1bkFmdGVyRmluZFRyaWdnZXIoXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5hZnRlckZpbmQsXG4gICAgICB0aGlzLmF1dGgsXG4gICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyxcbiAgICAgIHRoaXMuY29uZmlnXG4gICAgKVxuICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgLy8gRW5zdXJlIHdlIHByb3Blcmx5IHNldCB0aGUgY2xhc3NOYW1lIGJhY2tcbiAgICAgIGlmICh0aGlzLnJlZGlyZWN0Q2xhc3NOYW1lKSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIFBhcnNlLk9iamVjdCkge1xuICAgICAgICAgICAgb2JqZWN0ID0gb2JqZWN0LnRvSlNPTigpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3QuY2xhc3NOYW1lID0gdGhpcy5yZWRpcmVjdENsYXNzTmFtZTtcbiAgICAgICAgICByZXR1cm4gb2JqZWN0O1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMucmVzcG9uc2UucmVzdWx0cyA9IHJlc3VsdHM7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG4vLyBBZGRzIGluY2x1ZGVkIHZhbHVlcyB0byB0aGUgcmVzcG9uc2UuXG4vLyBQYXRoIGlzIGEgbGlzdCBvZiBmaWVsZCBuYW1lcy5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhbiBhdWdtZW50ZWQgcmVzcG9uc2UuXG5mdW5jdGlvbiBpbmNsdWRlUGF0aChjb25maWcsIGF1dGgsIHJlc3BvbnNlLCBwYXRoLCByZXN0T3B0aW9ucyA9IHt9KSB7XG4gIHZhciBwb2ludGVycyA9IGZpbmRQb2ludGVycyhyZXNwb25zZS5yZXN1bHRzLCBwYXRoKTtcbiAgaWYgKHBvaW50ZXJzLmxlbmd0aCA9PSAwKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG4gIGNvbnN0IHBvaW50ZXJzSGFzaCA9IHt9O1xuICBmb3IgKHZhciBwb2ludGVyIG9mIHBvaW50ZXJzKSB7XG4gICAgaWYgKCFwb2ludGVyKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NOYW1lID0gcG9pbnRlci5jbGFzc05hbWU7XG4gICAgLy8gb25seSBpbmNsdWRlIHRoZSBnb29kIHBvaW50ZXJzXG4gICAgaWYgKGNsYXNzTmFtZSkge1xuICAgICAgcG9pbnRlcnNIYXNoW2NsYXNzTmFtZV0gPSBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXSB8fCBuZXcgU2V0KCk7XG4gICAgICBwb2ludGVyc0hhc2hbY2xhc3NOYW1lXS5hZGQocG9pbnRlci5vYmplY3RJZCk7XG4gICAgfVxuICB9XG4gIGNvbnN0IGluY2x1ZGVSZXN0T3B0aW9ucyA9IHt9O1xuICBpZiAocmVzdE9wdGlvbnMua2V5cykge1xuICAgIGNvbnN0IGtleXMgPSBuZXcgU2V0KHJlc3RPcHRpb25zLmtleXMuc3BsaXQoJywnKSk7XG4gICAgY29uc3Qga2V5U2V0ID0gQXJyYXkuZnJvbShrZXlzKS5yZWR1Y2UoKHNldCwga2V5KSA9PiB7XG4gICAgICBjb25zdCBrZXlQYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gICAgICBsZXQgaSA9IDA7XG4gICAgICBmb3IgKGk7IGkgPCBwYXRoLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChwYXRoW2ldICE9IGtleVBhdGhbaV0pIHtcbiAgICAgICAgICByZXR1cm4gc2V0O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoaSA8IGtleVBhdGgubGVuZ3RoKSB7XG4gICAgICAgIHNldC5hZGQoa2V5UGF0aFtpXSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2V0O1xuICAgIH0sIG5ldyBTZXQoKSk7XG4gICAgaWYgKGtleVNldC5zaXplID4gMCkge1xuICAgICAgaW5jbHVkZVJlc3RPcHRpb25zLmtleXMgPSBBcnJheS5mcm9tKGtleVNldCkuam9pbignLCcpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2UpIHtcbiAgICBpbmNsdWRlUmVzdE9wdGlvbnMucmVhZFByZWZlcmVuY2UgPSByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gICAgaW5jbHVkZVJlc3RPcHRpb25zLmluY2x1ZGVSZWFkUHJlZmVyZW5jZSA9XG4gICAgICByZXN0T3B0aW9ucy5pbmNsdWRlUmVhZFByZWZlcmVuY2U7XG4gIH1cblxuICBjb25zdCBxdWVyeVByb21pc2VzID0gT2JqZWN0LmtleXMocG9pbnRlcnNIYXNoKS5tYXAoY2xhc3NOYW1lID0+IHtcbiAgICBjb25zdCBvYmplY3RJZHMgPSBBcnJheS5mcm9tKHBvaW50ZXJzSGFzaFtjbGFzc05hbWVdKTtcbiAgICBsZXQgd2hlcmU7XG4gICAgaWYgKG9iamVjdElkcy5sZW5ndGggPT09IDEpIHtcbiAgICAgIHdoZXJlID0geyBvYmplY3RJZDogb2JqZWN0SWRzWzBdIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIHdoZXJlID0geyBvYmplY3RJZDogeyAkaW46IG9iamVjdElkcyB9IH07XG4gICAgfVxuICAgIHZhciBxdWVyeSA9IG5ldyBSZXN0UXVlcnkoXG4gICAgICBjb25maWcsXG4gICAgICBhdXRoLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgd2hlcmUsXG4gICAgICBpbmNsdWRlUmVzdE9wdGlvbnNcbiAgICApO1xuICAgIHJldHVybiBxdWVyeS5leGVjdXRlKHsgb3A6ICdnZXQnIH0pLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICByZXN1bHRzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0cyk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIEdldCB0aGUgb2JqZWN0cyBmb3IgYWxsIHRoZXNlIG9iamVjdCBpZHNcbiAgcmV0dXJuIFByb21pc2UuYWxsKHF1ZXJ5UHJvbWlzZXMpLnRoZW4ocmVzcG9uc2VzID0+IHtcbiAgICB2YXIgcmVwbGFjZSA9IHJlc3BvbnNlcy5yZWR1Y2UoKHJlcGxhY2UsIGluY2x1ZGVSZXNwb25zZSkgPT4ge1xuICAgICAgZm9yICh2YXIgb2JqIG9mIGluY2x1ZGVSZXNwb25zZS5yZXN1bHRzKSB7XG4gICAgICAgIG9iai5fX3R5cGUgPSAnT2JqZWN0JztcbiAgICAgICAgb2JqLmNsYXNzTmFtZSA9IGluY2x1ZGVSZXNwb25zZS5jbGFzc05hbWU7XG5cbiAgICAgICAgaWYgKG9iai5jbGFzc05hbWUgPT0gJ19Vc2VyJyAmJiAhYXV0aC5pc01hc3Rlcikge1xuICAgICAgICAgIGRlbGV0ZSBvYmouc2Vzc2lvblRva2VuO1xuICAgICAgICAgIGRlbGV0ZSBvYmouYXV0aERhdGE7XG4gICAgICAgIH1cbiAgICAgICAgcmVwbGFjZVtvYmoub2JqZWN0SWRdID0gb2JqO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlcGxhY2U7XG4gICAgfSwge30pO1xuXG4gICAgdmFyIHJlc3AgPSB7XG4gICAgICByZXN1bHRzOiByZXBsYWNlUG9pbnRlcnMocmVzcG9uc2UucmVzdWx0cywgcGF0aCwgcmVwbGFjZSksXG4gICAgfTtcbiAgICBpZiAocmVzcG9uc2UuY291bnQpIHtcbiAgICAgIHJlc3AuY291bnQgPSByZXNwb25zZS5jb3VudDtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3A7XG4gIH0pO1xufVxuXG4vLyBPYmplY3QgbWF5IGJlIGEgbGlzdCBvZiBSRVNULWZvcm1hdCBvYmplY3QgdG8gZmluZCBwb2ludGVycyBpbiwgb3Jcbi8vIGl0IG1heSBiZSBhIHNpbmdsZSBvYmplY3QuXG4vLyBJZiB0aGUgcGF0aCB5aWVsZHMgdGhpbmdzIHRoYXQgYXJlbid0IHBvaW50ZXJzLCB0aGlzIHRocm93cyBhbiBlcnJvci5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIFJldHVybnMgYSBsaXN0IG9mIHBvaW50ZXJzIGluIFJFU1QgZm9ybWF0LlxuZnVuY3Rpb24gZmluZFBvaW50ZXJzKG9iamVjdCwgcGF0aCkge1xuICBpZiAob2JqZWN0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICB2YXIgYW5zd2VyID0gW107XG4gICAgZm9yICh2YXIgeCBvZiBvYmplY3QpIHtcbiAgICAgIGFuc3dlciA9IGFuc3dlci5jb25jYXQoZmluZFBvaW50ZXJzKHgsIHBhdGgpKTtcbiAgICB9XG4gICAgcmV0dXJuIGFuc3dlcjtcbiAgfVxuXG4gIGlmICh0eXBlb2Ygb2JqZWN0ICE9PSAnb2JqZWN0JyB8fCAhb2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKHBhdGgubGVuZ3RoID09IDApIHtcbiAgICBpZiAob2JqZWN0ID09PSBudWxsIHx8IG9iamVjdC5fX3R5cGUgPT0gJ1BvaW50ZXInKSB7XG4gICAgICByZXR1cm4gW29iamVjdF07XG4gICAgfVxuICAgIHJldHVybiBbXTtcbiAgfVxuXG4gIHZhciBzdWJvYmplY3QgPSBvYmplY3RbcGF0aFswXV07XG4gIGlmICghc3Vib2JqZWN0KSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIHJldHVybiBmaW5kUG9pbnRlcnMoc3Vib2JqZWN0LCBwYXRoLnNsaWNlKDEpKTtcbn1cblxuLy8gT2JqZWN0IG1heSBiZSBhIGxpc3Qgb2YgUkVTVC1mb3JtYXQgb2JqZWN0cyB0byByZXBsYWNlIHBvaW50ZXJzXG4vLyBpbiwgb3IgaXQgbWF5IGJlIGEgc2luZ2xlIG9iamVjdC5cbi8vIFBhdGggaXMgYSBsaXN0IG9mIGZpZWxkcyB0byBzZWFyY2ggaW50by5cbi8vIHJlcGxhY2UgaXMgYSBtYXAgZnJvbSBvYmplY3QgaWQgLT4gb2JqZWN0LlxuLy8gUmV0dXJucyBzb21ldGhpbmcgYW5hbG9nb3VzIHRvIG9iamVjdCwgYnV0IHdpdGggdGhlIGFwcHJvcHJpYXRlXG4vLyBwb2ludGVycyBpbmZsYXRlZC5cbmZ1bmN0aW9uIHJlcGxhY2VQb2ludGVycyhvYmplY3QsIHBhdGgsIHJlcGxhY2UpIHtcbiAgaWYgKG9iamVjdCBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgcmV0dXJuIG9iamVjdFxuICAgICAgLm1hcChvYmogPT4gcmVwbGFjZVBvaW50ZXJzKG9iaiwgcGF0aCwgcmVwbGFjZSkpXG4gICAgICAuZmlsdGVyKG9iaiA9PiB0eXBlb2Ygb2JqICE9PSAndW5kZWZpbmVkJyk7XG4gIH1cblxuICBpZiAodHlwZW9mIG9iamVjdCAhPT0gJ29iamVjdCcgfHwgIW9iamVjdCkge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICBpZiAocGF0aC5sZW5ndGggPT09IDApIHtcbiAgICBpZiAob2JqZWN0ICYmIG9iamVjdC5fX3R5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgcmV0dXJuIHJlcGxhY2Vbb2JqZWN0Lm9iamVjdElkXTtcbiAgICB9XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIHZhciBzdWJvYmplY3QgPSBvYmplY3RbcGF0aFswXV07XG4gIGlmICghc3Vib2JqZWN0KSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuICB2YXIgbmV3c3ViID0gcmVwbGFjZVBvaW50ZXJzKHN1Ym9iamVjdCwgcGF0aC5zbGljZSgxKSwgcmVwbGFjZSk7XG4gIHZhciBhbnN3ZXIgPSB7fTtcbiAgZm9yICh2YXIga2V5IGluIG9iamVjdCkge1xuICAgIGlmIChrZXkgPT0gcGF0aFswXSkge1xuICAgICAgYW5zd2VyW2tleV0gPSBuZXdzdWI7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFuc3dlcltrZXldID0gb2JqZWN0W2tleV07XG4gICAgfVxuICB9XG4gIHJldHVybiBhbnN3ZXI7XG59XG5cbi8vIEZpbmRzIGEgc3Vib2JqZWN0IHRoYXQgaGFzIHRoZSBnaXZlbiBrZXksIGlmIHRoZXJlIGlzIG9uZS5cbi8vIFJldHVybnMgdW5kZWZpbmVkIG90aGVyd2lzZS5cbmZ1bmN0aW9uIGZpbmRPYmplY3RXaXRoS2V5KHJvb3QsIGtleSkge1xuICBpZiAodHlwZW9mIHJvb3QgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChyb290IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICBmb3IgKHZhciBpdGVtIG9mIHJvb3QpIHtcbiAgICAgIGNvbnN0IGFuc3dlciA9IGZpbmRPYmplY3RXaXRoS2V5KGl0ZW0sIGtleSk7XG4gICAgICBpZiAoYW5zd2VyKSB7XG4gICAgICAgIHJldHVybiBhbnN3ZXI7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGlmIChyb290ICYmIHJvb3Rba2V5XSkge1xuICAgIHJldHVybiByb290O1xuICB9XG4gIGZvciAodmFyIHN1YmtleSBpbiByb290KSB7XG4gICAgY29uc3QgYW5zd2VyID0gZmluZE9iamVjdFdpdGhLZXkocm9vdFtzdWJrZXldLCBrZXkpO1xuICAgIGlmIChhbnN3ZXIpIHtcbiAgICAgIHJldHVybiBhbnN3ZXI7XG4gICAgfVxuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gUmVzdFF1ZXJ5O1xuIl19