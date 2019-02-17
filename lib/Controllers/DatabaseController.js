"use strict";

var _node = require("parse/node");

var _lodash = _interopRequireDefault(require("lodash"));

var _intersect = _interopRequireDefault(require("intersect"));

var _deepcopy = _interopRequireDefault(require("deepcopy"));

var _logger = _interopRequireDefault(require("../logger"));

var SchemaController = _interopRequireWildcard(require("./SchemaController"));

var _StorageAdapter = require("../Adapters/Storage/StorageAdapter");

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; var ownKeys = Object.keys(source); if (typeof Object.getOwnPropertySymbols === 'function') { ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(source).filter(function (sym) { return Object.getOwnPropertyDescriptor(source, sym).enumerable; })); } ownKeys.forEach(function (key) { _defineProperty(target, key, source[key]); }); } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function _objectWithoutProperties(source, excluded) { if (source == null) return {}; var target = _objectWithoutPropertiesLoose(source, excluded); var key, i; if (Object.getOwnPropertySymbols) { var sourceSymbolKeys = Object.getOwnPropertySymbols(source); for (i = 0; i < sourceSymbolKeys.length; i++) { key = sourceSymbolKeys[i]; if (excluded.indexOf(key) >= 0) continue; if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue; target[key] = source[key]; } } return target; }

function _objectWithoutPropertiesLoose(source, excluded) { if (source == null) return {}; var target = {}; var sourceKeys = Object.keys(source); var key, i; for (i = 0; i < sourceKeys.length; i++) { key = sourceKeys[i]; if (excluded.indexOf(key) >= 0) continue; target[key] = source[key]; } return target; }

function addWriteACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query); //Can't be any existing '_wperm' query, we don't allow client queries on that, no need to $and


  newQuery._wperm = {
    $in: [null, ...acl]
  };
  return newQuery;
}

function addReadACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query); //Can't be any existing '_rperm' query, we don't allow client queries on that, no need to $and


  newQuery._rperm = {
    $in: [null, '*', ...acl]
  };
  return newQuery;
} // Transforms a REST API formatted ACL object to our two-field mongo format.


const transformObjectACL = (_ref) => {
  let {
    ACL
  } = _ref,
      result = _objectWithoutProperties(_ref, ["ACL"]);

  if (!ACL) {
    return result;
  }

  result._wperm = [];
  result._rperm = [];

  for (const entry in ACL) {
    if (ACL[entry].read) {
      result._rperm.push(entry);
    }

    if (ACL[entry].write) {
      result._wperm.push(entry);
    }
  }

  return result;
};

const specialQuerykeys = ['$and', '$or', '$nor', '_rperm', '_wperm', '_perishable_token', '_email_verify_token', '_email_verify_token_expires_at', '_account_lockout_expires_at', '_failed_login_count'];

const isSpecialQueryKey = key => {
  return specialQuerykeys.indexOf(key) >= 0;
};

const validateQuery = query => {
  if (query.ACL) {
    throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Cannot query on ACL.');
  }

  if (query.$or) {
    if (query.$or instanceof Array) {
      query.$or.forEach(validateQuery);
      /* In MongoDB, $or queries which are not alone at the top level of the
       * query can not make efficient use of indexes due to a long standing
       * bug known as SERVER-13732.
       *
       * This block restructures queries in which $or is not the sole top
       * level element by moving all other top-level predicates inside every
       * subdocument of the $or predicate, allowing MongoDB's query planner
       * to make full use of the most relevant indexes.
       *
       * EG:      {$or: [{a: 1}, {a: 2}], b: 2}
       * Becomes: {$or: [{a: 1, b: 2}, {a: 2, b: 2}]}
       *
       * The only exceptions are $near and $nearSphere operators, which are
       * constrained to only 1 operator per query. As a result, these ops
       * remain at the top level
       *
       * https://jira.mongodb.org/browse/SERVER-13732
       * https://github.com/parse-community/parse-server/issues/3767
       */

      Object.keys(query).forEach(key => {
        const noCollisions = !query.$or.some(subq => subq.hasOwnProperty(key));
        let hasNears = false;

        if (query[key] != null && typeof query[key] == 'object') {
          hasNears = '$near' in query[key] || '$nearSphere' in query[key];
        }

        if (key != '$or' && noCollisions && !hasNears) {
          query.$or.forEach(subquery => {
            subquery[key] = query[key];
          });
          delete query[key];
        }
      });
      query.$or.forEach(validateQuery);
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $or format - use an array value.');
    }
  }

  if (query.$and) {
    if (query.$and instanceof Array) {
      query.$and.forEach(validateQuery);
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $and format - use an array value.');
    }
  }

  if (query.$nor) {
    if (query.$nor instanceof Array && query.$nor.length > 0) {
      query.$nor.forEach(validateQuery);
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $nor format - use an array of at least 1 value.');
    }
  }

  Object.keys(query).forEach(key => {
    if (query && query[key] && query[key].$regex) {
      if (typeof query[key].$options === 'string') {
        if (!query[key].$options.match(/^[imxs]+$/)) {
          throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Bad $options value for query: ${query[key].$options}`);
        }
      }
    }

    if (!isSpecialQueryKey(key) && !key.match(/^[a-zA-Z][a-zA-Z0-9_\.]*$/)) {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid key name: ${key}`);
    }
  });
}; // Filters out any data that shouldn't be on this REST-formatted object.


const filterSensitiveData = (isMaster, aclGroup, className, object) => {
  if (className !== '_User') {
    return object;
  }

  object.password = object._hashed_password;
  delete object._hashed_password;
  delete object.sessionToken;

  if (isMaster) {
    return object;
  }

  delete object._email_verify_token;
  delete object._perishable_token;
  delete object._perishable_token_expires_at;
  delete object._tombstone;
  delete object._email_verify_token_expires_at;
  delete object._failed_login_count;
  delete object._account_lockout_expires_at;
  delete object._password_changed_at;
  delete object._password_history;

  if (aclGroup.indexOf(object.objectId) > -1) {
    return object;
  }

  delete object.authData;
  return object;
};

// Runs an update on the database.
// Returns a promise for an object with the new values for field
// modifications that don't know their results ahead of time, like
// 'increment'.
// Options:
//   acl:  a list of strings. If the object to be updated has an ACL,
//         one of the provided strings must provide the caller with
//         write permissions.
const specialKeysForUpdate = ['_hashed_password', '_perishable_token', '_email_verify_token', '_email_verify_token_expires_at', '_account_lockout_expires_at', '_failed_login_count', '_perishable_token_expires_at', '_password_changed_at', '_password_history'];

const isSpecialUpdateKey = key => {
  return specialKeysForUpdate.indexOf(key) >= 0;
};

function expandResultOnKeyPath(object, key, value) {
  if (key.indexOf('.') < 0) {
    object[key] = value[key];
    return object;
  }

  const path = key.split('.');
  const firstKey = path[0];
  const nextPath = path.slice(1).join('.');
  object[firstKey] = expandResultOnKeyPath(object[firstKey] || {}, nextPath, value[firstKey]);
  delete object[key];
  return object;
}

function sanitizeDatabaseResult(originalObject, result) {
  const response = {};

  if (!result) {
    return Promise.resolve(response);
  }

  Object.keys(originalObject).forEach(key => {
    const keyUpdate = originalObject[key]; // determine if that was an op

    if (keyUpdate && typeof keyUpdate === 'object' && keyUpdate.__op && ['Add', 'AddUnique', 'Remove', 'Increment'].indexOf(keyUpdate.__op) > -1) {
      // only valid ops that produce an actionable result
      // the op may have happend on a keypath
      expandResultOnKeyPath(response, key, result);
    }
  });
  return Promise.resolve(response);
}

function joinTableName(className, key) {
  return `_Join:${key}:${className}`;
}

const flattenUpdateOperatorsForCreate = object => {
  for (const key in object) {
    if (object[key] && object[key].__op) {
      switch (object[key].__op) {
        case 'Increment':
          if (typeof object[key].amount !== 'number') {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].amount;
          break;

        case 'Add':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].objects;
          break;

        case 'AddUnique':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].objects;
          break;

        case 'Remove':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = [];
          break;

        case 'Delete':
          delete object[key];
          break;

        default:
          throw new _node.Parse.Error(_node.Parse.Error.COMMAND_UNAVAILABLE, `The ${object[key].__op} operator is not supported yet.`);
      }
    }
  }
};

const transformAuthData = (className, object, schema) => {
  if (object.authData && className === '_User') {
    Object.keys(object.authData).forEach(provider => {
      const providerData = object.authData[provider];
      const fieldName = `_auth_data_${provider}`;

      if (providerData == null) {
        object[fieldName] = {
          __op: 'Delete'
        };
      } else {
        object[fieldName] = providerData;
        schema.fields[fieldName] = {
          type: 'Object'
        };
      }
    });
    delete object.authData;
  }
}; // Transforms a Database format ACL to a REST API format ACL


const untransformObjectACL = (_ref2) => {
  let {
    _rperm,
    _wperm
  } = _ref2,
      output = _objectWithoutProperties(_ref2, ["_rperm", "_wperm"]);

  if (_rperm || _wperm) {
    output.ACL = {};

    (_rperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          read: true
        };
      } else {
        output.ACL[entry]['read'] = true;
      }
    });

    (_wperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          write: true
        };
      } else {
        output.ACL[entry]['write'] = true;
      }
    });
  }

  return output;
};
/**
 * When querying, the fieldName may be compound, extract the root fieldName
 *     `temperature.celsius` becomes `temperature`
 * @param {string} fieldName that may be a compound field name
 * @returns {string} the root name of the field
 */


const getRootFieldName = fieldName => {
  return fieldName.split('.')[0];
};

const relationSchema = {
  fields: {
    relatedId: {
      type: 'String'
    },
    owningId: {
      type: 'String'
    }
  }
};

class DatabaseController {
  constructor(adapter, schemaCache) {
    this.adapter = adapter;
    this.schemaCache = schemaCache; // We don't want a mutable this.schema, because then you could have
    // one request that uses different schemas for different parts of
    // it. Instead, use loadSchema to get a schema.

    this.schemaPromise = null;
  }

  collectionExists(className) {
    return this.adapter.classExists(className);
  }

  purgeCollection(className) {
    return this.loadSchema().then(schemaController => schemaController.getOneSchema(className)).then(schema => this.adapter.deleteObjectsByQuery(className, schema, {}));
  }

  validateClassName(className) {
    if (!SchemaController.classNameIsValid(className)) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_CLASS_NAME, 'invalid className: ' + className));
    }

    return Promise.resolve();
  } // Returns a promise for a schemaController.


  loadSchema(options = {
    clearCache: false
  }) {
    if (this.schemaPromise != null) {
      return this.schemaPromise;
    }

    this.schemaPromise = SchemaController.load(this.adapter, this.schemaCache, options);
    this.schemaPromise.then(() => delete this.schemaPromise, () => delete this.schemaPromise);
    return this.loadSchema(options);
  } // Returns a promise for the classname that is related to the given
  // classname through the key.
  // TODO: make this not in the DatabaseController interface


  redirectClassNameForKey(className, key) {
    return this.loadSchema().then(schema => {
      var t = schema.getExpectedType(className, key);

      if (t != null && typeof t !== 'string' && t.type === 'Relation') {
        return t.targetClass;
      }

      return className;
    });
  } // Uses the schema to validate the object (REST API format).
  // Returns a promise that resolves to the new schema.
  // This does not update this.schema, because in a situation like a
  // batch request, that could confuse other users of the schema.


  validateObject(className, object, query, {
    acl
  }) {
    let schema;
    const isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchema().then(s => {
      schema = s;

      if (isMaster) {
        return Promise.resolve();
      }

      return this.canAddField(schema, className, object, aclGroup);
    }).then(() => {
      return schema.validateObject(className, object, query);
    });
  }

  update(className, query, update, {
    acl,
    many,
    upsert
  } = {}, skipSanitization = false) {
    const originalQuery = query;
    const originalUpdate = update; // Make a copy of the object, so we don't mutate the incoming data.

    update = (0, _deepcopy.default)(update);
    var relationUpdates = [];
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchema().then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'update')).then(() => {
        relationUpdates = this.collectRelationUpdates(className, originalQuery.objectId, update);

        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'update', query, aclGroup);
        }

        if (!query) {
          return Promise.resolve();
        }

        if (acl) {
          query = addWriteACL(query, acl);
        }

        validateQuery(query);
        return schemaController.getOneSchema(className, true).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }

          throw error;
        }).then(schema => {
          Object.keys(update).forEach(fieldName => {
            if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }

            const rootFieldName = getRootFieldName(fieldName);

            if (!SchemaController.fieldNameIsValid(rootFieldName) && !isSpecialUpdateKey(rootFieldName)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }
          });

          for (const updateOperation in update) {
            if (update[updateOperation] && typeof update[updateOperation] === 'object' && Object.keys(update[updateOperation]).some(innerKey => innerKey.includes('$') || innerKey.includes('.'))) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
            }
          }

          update = transformObjectACL(update);
          transformAuthData(className, update, schema);

          if (many) {
            return this.adapter.updateObjectsByQuery(className, schema, query, update);
          } else if (upsert) {
            return this.adapter.upsertOneObject(className, schema, query, update);
          } else {
            return this.adapter.findOneAndUpdate(className, schema, query, update);
          }
        });
      }).then(result => {
        if (!result) {
          throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
        }

        return this.handleRelationUpdates(className, originalQuery.objectId, update, relationUpdates).then(() => {
          return result;
        });
      }).then(result => {
        if (skipSanitization) {
          return Promise.resolve(result);
        }

        return sanitizeDatabaseResult(originalUpdate, result);
      });
    });
  } // Collect all relation-updating operations from a REST-format update.
  // Returns a list of all relation updates to perform
  // This mutates update.


  collectRelationUpdates(className, objectId, update) {
    var ops = [];
    var deleteMe = [];
    objectId = update.objectId || objectId;

    var process = (op, key) => {
      if (!op) {
        return;
      }

      if (op.__op == 'AddRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }

      if (op.__op == 'RemoveRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }

      if (op.__op == 'Batch') {
        for (var x of op.ops) {
          process(x, key);
        }
      }
    };

    for (const key in update) {
      process(update[key], key);
    }

    for (const key of deleteMe) {
      delete update[key];
    }

    return ops;
  } // Processes relation-updating operations from a REST-format update.
  // Returns a promise that resolves when all updates have been performed


  handleRelationUpdates(className, objectId, update, ops) {
    var pending = [];
    objectId = update.objectId || objectId;
    ops.forEach(({
      key,
      op
    }) => {
      if (!op) {
        return;
      }

      if (op.__op == 'AddRelation') {
        for (const object of op.objects) {
          pending.push(this.addRelation(key, className, objectId, object.objectId));
        }
      }

      if (op.__op == 'RemoveRelation') {
        for (const object of op.objects) {
          pending.push(this.removeRelation(key, className, objectId, object.objectId));
        }
      }
    });
    return Promise.all(pending);
  } // Adds a relation.
  // Returns a promise that resolves successfully iff the add was successful.


  addRelation(key, fromClassName, fromId, toId) {
    const doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.upsertOneObject(`_Join:${key}:${fromClassName}`, relationSchema, doc, doc);
  } // Removes a relation.
  // Returns a promise that resolves successfully iff the remove was
  // successful.


  removeRelation(key, fromClassName, fromId, toId) {
    var doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.deleteObjectsByQuery(`_Join:${key}:${fromClassName}`, relationSchema, doc).catch(error => {
      // We don't care if they try to delete a non-existent relation.
      if (error.code == _node.Parse.Error.OBJECT_NOT_FOUND) {
        return;
      }

      throw error;
    });
  } // Removes objects matches this query from the database.
  // Returns a promise that resolves successfully iff the object was
  // deleted.
  // Options:
  //   acl:  a list of strings. If the object to be updated has an ACL,
  //         one of the provided strings must provide the caller with
  //         write permissions.


  destroy(className, query, {
    acl
  } = {}) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    return this.loadSchema().then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'delete')).then(() => {
        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'delete', query, aclGroup);

          if (!query) {
            throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
          }
        } // delete by query


        if (acl) {
          query = addWriteACL(query, acl);
        }

        validateQuery(query);
        return schemaController.getOneSchema(className).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }

          throw error;
        }).then(parseFormatSchema => this.adapter.deleteObjectsByQuery(className, parseFormatSchema, query)).catch(error => {
          // When deleting sessions while changing passwords, don't throw an error if they don't have any sessions.
          if (className === '_Session' && error.code === _node.Parse.Error.OBJECT_NOT_FOUND) {
            return Promise.resolve({});
          }

          throw error;
        });
      });
    });
  } // Inserts an object into the database.
  // Returns a promise that resolves successfully iff the object saved.


  create(className, object, {
    acl
  } = {}) {
    // Make a copy of the object, so we don't mutate the incoming data.
    const originalObject = object;
    object = transformObjectACL(object);
    object.createdAt = {
      iso: object.createdAt,
      __type: 'Date'
    };
    object.updatedAt = {
      iso: object.updatedAt,
      __type: 'Date'
    };
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    const relationUpdates = this.collectRelationUpdates(className, null, object);
    return this.validateClassName(className).then(() => this.loadSchema()).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'create')).then(() => schemaController.enforceClassExists(className)).then(() => schemaController.reloadData()).then(() => schemaController.getOneSchema(className, true)).then(schema => {
        transformAuthData(className, object, schema);
        flattenUpdateOperatorsForCreate(object);
        return this.adapter.createObject(className, SchemaController.convertSchemaToAdapterSchema(schema), object);
      }).then(result => {
        return this.handleRelationUpdates(className, object.objectId, object, relationUpdates).then(() => {
          return sanitizeDatabaseResult(originalObject, result.ops[0]);
        });
      });
    });
  }

  canAddField(schema, className, object, aclGroup) {
    const classSchema = schema.schemaData[className];

    if (!classSchema) {
      return Promise.resolve();
    }

    const fields = Object.keys(object);
    const schemaFields = Object.keys(classSchema.fields);
    const newKeys = fields.filter(field => {
      // Skip fields that are unset
      if (object[field] && object[field].__op && object[field].__op === 'Delete') {
        return false;
      }

      return schemaFields.indexOf(field) < 0;
    });

    if (newKeys.length > 0) {
      return schema.validatePermission(className, aclGroup, 'addField');
    }

    return Promise.resolve();
  } // Won't delete collections in the system namespace

  /**
   * Delete all classes and clears the schema cache
   *
   * @param {boolean} fast set to true if it's ok to just delete rows and not indexes
   * @returns {Promise<void>} when the deletions completes
   */


  deleteEverything(fast = false) {
    this.schemaPromise = null;
    return Promise.all([this.adapter.deleteAllClasses(fast), this.schemaCache.clear()]);
  } // Returns a promise for a list of related ids given an owning id.
  // className here is the owning className.


  relatedIds(className, key, owningId, queryOptions) {
    const {
      skip,
      limit,
      sort
    } = queryOptions;
    const findOptions = {};

    if (sort && sort.createdAt && this.adapter.canSortOnJoinTables) {
      findOptions.sort = {
        _id: sort.createdAt
      };
      findOptions.limit = limit;
      findOptions.skip = skip;
      queryOptions.skip = 0;
    }

    return this.adapter.find(joinTableName(className, key), relationSchema, {
      owningId
    }, findOptions).then(results => results.map(result => result.relatedId));
  } // Returns a promise for a list of owning ids given some related ids.
  // className here is the owning className.


  owningIds(className, key, relatedIds) {
    return this.adapter.find(joinTableName(className, key), relationSchema, {
      relatedId: {
        $in: relatedIds
      }
    }, {}).then(results => results.map(result => result.owningId));
  } // Modifies query so that it no longer has $in on relation fields, or
  // equal-to-pointer constraints on relation fields.
  // Returns a promise that resolves when query is mutated


  reduceInRelation(className, query, schema) {
    // Search for an in-relation or equal-to-relation
    // Make it sequential for now, not sure of paralleization side effects
    if (query['$or']) {
      const ors = query['$or'];
      return Promise.all(ors.map((aQuery, index) => {
        return this.reduceInRelation(className, aQuery, schema).then(aQuery => {
          query['$or'][index] = aQuery;
        });
      })).then(() => {
        return Promise.resolve(query);
      });
    }

    const promises = Object.keys(query).map(key => {
      const t = schema.getExpectedType(className, key);

      if (!t || t.type !== 'Relation') {
        return Promise.resolve(query);
      }

      let queries = null;

      if (query[key] && (query[key]['$in'] || query[key]['$ne'] || query[key]['$nin'] || query[key].__type == 'Pointer')) {
        // Build the list of queries
        queries = Object.keys(query[key]).map(constraintKey => {
          let relatedIds;
          let isNegation = false;

          if (constraintKey === 'objectId') {
            relatedIds = [query[key].objectId];
          } else if (constraintKey == '$in') {
            relatedIds = query[key]['$in'].map(r => r.objectId);
          } else if (constraintKey == '$nin') {
            isNegation = true;
            relatedIds = query[key]['$nin'].map(r => r.objectId);
          } else if (constraintKey == '$ne') {
            isNegation = true;
            relatedIds = [query[key]['$ne'].objectId];
          } else {
            return;
          }

          return {
            isNegation,
            relatedIds
          };
        });
      } else {
        queries = [{
          isNegation: false,
          relatedIds: []
        }];
      } // remove the current queryKey as we don,t need it anymore


      delete query[key]; // execute each query independently to build the list of
      // $in / $nin

      const promises = queries.map(q => {
        if (!q) {
          return Promise.resolve();
        }

        return this.owningIds(className, key, q.relatedIds).then(ids => {
          if (q.isNegation) {
            this.addNotInObjectIdsIds(ids, query);
          } else {
            this.addInObjectIdsIds(ids, query);
          }

          return Promise.resolve();
        });
      });
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      });
    });
    return Promise.all(promises).then(() => {
      return Promise.resolve(query);
    });
  } // Modifies query so that it no longer has $relatedTo
  // Returns a promise that resolves when query is mutated


  reduceRelationKeys(className, query, queryOptions) {
    if (query['$or']) {
      return Promise.all(query['$or'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions);
      }));
    }

    var relatedTo = query['$relatedTo'];

    if (relatedTo) {
      return this.relatedIds(relatedTo.object.className, relatedTo.key, relatedTo.object.objectId, queryOptions).then(ids => {
        delete query['$relatedTo'];
        this.addInObjectIdsIds(ids, query);
        return this.reduceRelationKeys(className, query, queryOptions);
      }).then(() => {});
    }
  }

  addInObjectIdsIds(ids = null, query) {
    const idsFromString = typeof query.objectId === 'string' ? [query.objectId] : null;
    const idsFromEq = query.objectId && query.objectId['$eq'] ? [query.objectId['$eq']] : null;
    const idsFromIn = query.objectId && query.objectId['$in'] ? query.objectId['$in'] : null; // -disable-next

    const allIds = [idsFromString, idsFromEq, idsFromIn, ids].filter(list => list !== null);
    const totalLength = allIds.reduce((memo, list) => memo + list.length, 0);
    let idsIntersection = [];

    if (totalLength > 125) {
      idsIntersection = _intersect.default.big(allIds);
    } else {
      idsIntersection = (0, _intersect.default)(allIds);
    } // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.


    if (!('objectId' in query)) {
      query.objectId = {
        $in: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $in: undefined,
        $eq: query.objectId
      };
    }

    query.objectId['$in'] = idsIntersection;
    return query;
  }

  addNotInObjectIdsIds(ids = [], query) {
    const idsFromNin = query.objectId && query.objectId['$nin'] ? query.objectId['$nin'] : [];
    let allIds = [...idsFromNin, ...ids].filter(list => list !== null); // make a set and spread to remove duplicates

    allIds = [...new Set(allIds)]; // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.

    if (!('objectId' in query)) {
      query.objectId = {
        $nin: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $nin: undefined,
        $eq: query.objectId
      };
    }

    query.objectId['$nin'] = allIds;
    return query;
  } // Runs a query on the database.
  // Returns a promise that resolves to a list of items.
  // Options:
  //   skip    number of results to skip.
  //   limit   limit to this number of results.
  //   sort    an object where keys are the fields to sort by.
  //           the value is +1 for ascending, -1 for descending.
  //   count   run a count instead of returning results.
  //   acl     restrict this operation with an ACL for the provided array
  //           of user objectIds and roles. acl: null means no user.
  //           when this field is not present, don't do anything regarding ACLs.
  // TODO: make userIds not needed here. The db adapter shouldn't know
  // anything about users, ideally. Then, improve the format of the ACL
  // arg to work like the others.


  find(className, query, {
    skip,
    limit,
    acl,
    sort = {},
    count,
    keys,
    op,
    distinct,
    pipeline,
    readPreference
  } = {}) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    op = op || (typeof query.objectId == 'string' && Object.keys(query).length === 1 ? 'get' : 'find'); // Count operation if counting

    op = count === true ? 'count' : op;
    let classExists = true;
    return this.loadSchema().then(schemaController => {
      //Allow volatile classes if querying with Master (for _PushStatus)
      //TODO: Move volatile classes concept into mongo adapter, postgres adapter shouldn't care
      //that api.parse.com breaks when _PushStatus exists in mongo.
      return schemaController.getOneSchema(className, isMaster).catch(error => {
        // Behavior for non-existent classes is kinda weird on Parse.com. Probably doesn't matter too much.
        // For now, pretend the class exists but has no objects,
        if (error === undefined) {
          classExists = false;
          return {
            fields: {}
          };
        }

        throw error;
      }).then(schema => {
        // Parse.com treats queries on _created_at and _updated_at as if they were queries on createdAt and updatedAt,
        // so duplicate that behavior here. If both are specified, the correct behavior to match Parse.com is to
        // use the one that appears first in the sort list.
        if (sort._created_at) {
          sort.createdAt = sort._created_at;
          delete sort._created_at;
        }

        if (sort._updated_at) {
          sort.updatedAt = sort._updated_at;
          delete sort._updated_at;
        }

        const queryOptions = {
          skip,
          limit,
          sort,
          keys,
          readPreference
        };
        Object.keys(sort).forEach(fieldName => {
          if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Cannot sort by ${fieldName}`);
          }

          const rootFieldName = getRootFieldName(fieldName);

          if (!SchemaController.fieldNameIsValid(rootFieldName)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}.`);
          }
        });
        return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, op)).then(() => this.reduceRelationKeys(className, query, queryOptions)).then(() => this.reduceInRelation(className, query, schemaController)).then(() => {
          if (!isMaster) {
            query = this.addPointerPermissions(schemaController, className, op, query, aclGroup);
          }

          if (!query) {
            if (op === 'get') {
              throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
            } else {
              return [];
            }
          }

          if (!isMaster) {
            if (op === 'update' || op === 'delete') {
              query = addWriteACL(query, aclGroup);
            } else {
              query = addReadACL(query, aclGroup);
            }
          }

          validateQuery(query);

          if (count) {
            if (!classExists) {
              return 0;
            } else {
              return this.adapter.count(className, schema, query, readPreference);
            }
          } else if (distinct) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.distinct(className, schema, query, distinct);
            }
          } else if (pipeline) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.aggregate(className, schema, pipeline, readPreference);
            }
          } else {
            return this.adapter.find(className, schema, query, queryOptions).then(objects => objects.map(object => {
              object = untransformObjectACL(object);
              return filterSensitiveData(isMaster, aclGroup, className, object);
            })).catch(error => {
              throw new _node.Parse.Error(_node.Parse.Error.INTERNAL_SERVER_ERROR, error);
            });
          }
        });
      });
    });
  }

  deleteSchema(className) {
    return this.loadSchema({
      clearCache: true
    }).then(schemaController => schemaController.getOneSchema(className, true)).catch(error => {
      if (error === undefined) {
        return {
          fields: {}
        };
      } else {
        throw error;
      }
    }).then(schema => {
      return this.collectionExists(className).then(() => this.adapter.count(className, {
        fields: {}
      })).then(count => {
        if (count > 0) {
          throw new _node.Parse.Error(255, `Class ${className} is not empty, contains ${count} objects, cannot drop schema.`);
        }

        return this.adapter.deleteClass(className);
      }).then(wasParseCollection => {
        if (wasParseCollection) {
          const relationFieldNames = Object.keys(schema.fields).filter(fieldName => schema.fields[fieldName].type === 'Relation');
          return Promise.all(relationFieldNames.map(name => this.adapter.deleteClass(joinTableName(className, name)))).then(() => {
            return;
          });
        } else {
          return Promise.resolve();
        }
      });
    });
  }

  addPointerPermissions(schema, className, operation, query, aclGroup = []) {
    // Check if class has public permission for operation
    // If the BaseCLP pass, let go through
    if (schema.testPermissionsForClassName(className, aclGroup, operation)) {
      return query;
    }

    const perms = schema.getClassLevelPermissions(className);
    const field = ['get', 'find'].indexOf(operation) > -1 ? 'readUserFields' : 'writeUserFields';
    const userACL = aclGroup.filter(acl => {
      return acl.indexOf('role:') != 0 && acl != '*';
    }); // the ACL should have exactly 1 user

    if (perms && perms[field] && perms[field].length > 0) {
      // No user set return undefined
      // If the length is > 1, that means we didn't de-dupe users correctly
      if (userACL.length != 1) {
        return;
      }

      const userId = userACL[0];
      const userPointer = {
        __type: 'Pointer',
        className: '_User',
        objectId: userId
      };
      const permFields = perms[field];
      const ors = permFields.map(key => {
        const q = {
          [key]: userPointer
        }; // if we already have a constraint on the key, use the $and

        if (query.hasOwnProperty(key)) {
          return {
            $and: [q, query]
          };
        } // otherwise just add the constaint


        return Object.assign({}, query, {
          [`${key}`]: userPointer
        });
      });

      if (ors.length > 1) {
        return {
          $or: ors
        };
      }

      return ors[0];
    } else {
      return query;
    }
  } // TODO: create indexes on first creation of a _User object. Otherwise it's impossible to
  // have a Parse app without it having a _User collection.


  performInitialization() {
    const requiredUserFields = {
      fields: _objectSpread({}, SchemaController.defaultColumns._Default, SchemaController.defaultColumns._User)
    };
    const requiredRoleFields = {
      fields: _objectSpread({}, SchemaController.defaultColumns._Default, SchemaController.defaultColumns._Role)
    };
    const userClassPromise = this.loadSchema().then(schema => schema.enforceClassExists('_User'));
    const roleClassPromise = this.loadSchema().then(schema => schema.enforceClassExists('_Role'));
    const usernameUniqueness = userClassPromise.then(() => this.adapter.ensureUniqueness('_User', requiredUserFields, ['username'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for usernames: ', error);

      throw error;
    });
    const emailUniqueness = userClassPromise.then(() => this.adapter.ensureUniqueness('_User', requiredUserFields, ['email'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for user email addresses: ', error);

      throw error;
    });
    const roleUniqueness = roleClassPromise.then(() => this.adapter.ensureUniqueness('_Role', requiredRoleFields, ['name'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for role name: ', error);

      throw error;
    });
    const indexPromise = this.adapter.updateSchemaWithIndexes(); // Create tables for volatile classes

    const adapterInit = this.adapter.performInitialization({
      VolatileClassesSchemas: SchemaController.VolatileClassesSchemas
    });
    return Promise.all([usernameUniqueness, emailUniqueness, roleUniqueness, adapterInit, indexPromise]);
  }

}

module.exports = DatabaseController; // Expose validateQuery for tests

module.exports._validateQuery = validateQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Db250cm9sbGVycy9EYXRhYmFzZUNvbnRyb2xsZXIuanMiXSwibmFtZXMiOlsiYWRkV3JpdGVBQ0wiLCJxdWVyeSIsImFjbCIsIm5ld1F1ZXJ5IiwiXyIsImNsb25lRGVlcCIsIl93cGVybSIsIiRpbiIsImFkZFJlYWRBQ0wiLCJfcnBlcm0iLCJ0cmFuc2Zvcm1PYmplY3RBQ0wiLCJBQ0wiLCJyZXN1bHQiLCJlbnRyeSIsInJlYWQiLCJwdXNoIiwid3JpdGUiLCJzcGVjaWFsUXVlcnlrZXlzIiwiaXNTcGVjaWFsUXVlcnlLZXkiLCJrZXkiLCJpbmRleE9mIiwidmFsaWRhdGVRdWVyeSIsIlBhcnNlIiwiRXJyb3IiLCJJTlZBTElEX1FVRVJZIiwiJG9yIiwiQXJyYXkiLCJmb3JFYWNoIiwiT2JqZWN0Iiwia2V5cyIsIm5vQ29sbGlzaW9ucyIsInNvbWUiLCJzdWJxIiwiaGFzT3duUHJvcGVydHkiLCJoYXNOZWFycyIsInN1YnF1ZXJ5IiwiJGFuZCIsIiRub3IiLCJsZW5ndGgiLCIkcmVnZXgiLCIkb3B0aW9ucyIsIm1hdGNoIiwiSU5WQUxJRF9LRVlfTkFNRSIsImZpbHRlclNlbnNpdGl2ZURhdGEiLCJpc01hc3RlciIsImFjbEdyb3VwIiwiY2xhc3NOYW1lIiwib2JqZWN0IiwicGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwic2Vzc2lvblRva2VuIiwiX2VtYWlsX3ZlcmlmeV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsIl90b21ic3RvbmUiLCJfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQiLCJfZmFpbGVkX2xvZ2luX2NvdW50IiwiX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0IiwiX3Bhc3N3b3JkX2NoYW5nZWRfYXQiLCJfcGFzc3dvcmRfaGlzdG9yeSIsIm9iamVjdElkIiwiYXV0aERhdGEiLCJzcGVjaWFsS2V5c0ZvclVwZGF0ZSIsImlzU3BlY2lhbFVwZGF0ZUtleSIsImV4cGFuZFJlc3VsdE9uS2V5UGF0aCIsInZhbHVlIiwicGF0aCIsInNwbGl0IiwiZmlyc3RLZXkiLCJuZXh0UGF0aCIsInNsaWNlIiwiam9pbiIsInNhbml0aXplRGF0YWJhc2VSZXN1bHQiLCJvcmlnaW5hbE9iamVjdCIsInJlc3BvbnNlIiwiUHJvbWlzZSIsInJlc29sdmUiLCJrZXlVcGRhdGUiLCJfX29wIiwiam9pblRhYmxlTmFtZSIsImZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUiLCJhbW91bnQiLCJJTlZBTElEX0pTT04iLCJvYmplY3RzIiwiQ09NTUFORF9VTkFWQUlMQUJMRSIsInRyYW5zZm9ybUF1dGhEYXRhIiwic2NoZW1hIiwicHJvdmlkZXIiLCJwcm92aWRlckRhdGEiLCJmaWVsZE5hbWUiLCJmaWVsZHMiLCJ0eXBlIiwidW50cmFuc2Zvcm1PYmplY3RBQ0wiLCJvdXRwdXQiLCJnZXRSb290RmllbGROYW1lIiwicmVsYXRpb25TY2hlbWEiLCJyZWxhdGVkSWQiLCJvd25pbmdJZCIsIkRhdGFiYXNlQ29udHJvbGxlciIsImNvbnN0cnVjdG9yIiwiYWRhcHRlciIsInNjaGVtYUNhY2hlIiwic2NoZW1hUHJvbWlzZSIsImNvbGxlY3Rpb25FeGlzdHMiLCJjbGFzc0V4aXN0cyIsInB1cmdlQ29sbGVjdGlvbiIsImxvYWRTY2hlbWEiLCJ0aGVuIiwic2NoZW1hQ29udHJvbGxlciIsImdldE9uZVNjaGVtYSIsImRlbGV0ZU9iamVjdHNCeVF1ZXJ5IiwidmFsaWRhdGVDbGFzc05hbWUiLCJTY2hlbWFDb250cm9sbGVyIiwiY2xhc3NOYW1lSXNWYWxpZCIsInJlamVjdCIsIklOVkFMSURfQ0xBU1NfTkFNRSIsIm9wdGlvbnMiLCJjbGVhckNhY2hlIiwibG9hZCIsInJlZGlyZWN0Q2xhc3NOYW1lRm9yS2V5IiwidCIsImdldEV4cGVjdGVkVHlwZSIsInRhcmdldENsYXNzIiwidmFsaWRhdGVPYmplY3QiLCJ1bmRlZmluZWQiLCJzIiwiY2FuQWRkRmllbGQiLCJ1cGRhdGUiLCJtYW55IiwidXBzZXJ0Iiwic2tpcFNhbml0aXphdGlvbiIsIm9yaWdpbmFsUXVlcnkiLCJvcmlnaW5hbFVwZGF0ZSIsInJlbGF0aW9uVXBkYXRlcyIsInZhbGlkYXRlUGVybWlzc2lvbiIsImNvbGxlY3RSZWxhdGlvblVwZGF0ZXMiLCJhZGRQb2ludGVyUGVybWlzc2lvbnMiLCJjYXRjaCIsImVycm9yIiwicm9vdEZpZWxkTmFtZSIsImZpZWxkTmFtZUlzVmFsaWQiLCJ1cGRhdGVPcGVyYXRpb24iLCJpbm5lcktleSIsImluY2x1ZGVzIiwiSU5WQUxJRF9ORVNURURfS0VZIiwidXBkYXRlT2JqZWN0c0J5UXVlcnkiLCJ1cHNlcnRPbmVPYmplY3QiLCJmaW5kT25lQW5kVXBkYXRlIiwiT0JKRUNUX05PVF9GT1VORCIsImhhbmRsZVJlbGF0aW9uVXBkYXRlcyIsIm9wcyIsImRlbGV0ZU1lIiwicHJvY2VzcyIsIm9wIiwieCIsInBlbmRpbmciLCJhZGRSZWxhdGlvbiIsInJlbW92ZVJlbGF0aW9uIiwiYWxsIiwiZnJvbUNsYXNzTmFtZSIsImZyb21JZCIsInRvSWQiLCJkb2MiLCJjb2RlIiwiZGVzdHJveSIsInBhcnNlRm9ybWF0U2NoZW1hIiwiY3JlYXRlIiwiY3JlYXRlZEF0IiwiaXNvIiwiX190eXBlIiwidXBkYXRlZEF0IiwiZW5mb3JjZUNsYXNzRXhpc3RzIiwicmVsb2FkRGF0YSIsImNyZWF0ZU9iamVjdCIsImNvbnZlcnRTY2hlbWFUb0FkYXB0ZXJTY2hlbWEiLCJjbGFzc1NjaGVtYSIsInNjaGVtYURhdGEiLCJzY2hlbWFGaWVsZHMiLCJuZXdLZXlzIiwiZmlsdGVyIiwiZmllbGQiLCJkZWxldGVFdmVyeXRoaW5nIiwiZmFzdCIsImRlbGV0ZUFsbENsYXNzZXMiLCJjbGVhciIsInJlbGF0ZWRJZHMiLCJxdWVyeU9wdGlvbnMiLCJza2lwIiwibGltaXQiLCJzb3J0IiwiZmluZE9wdGlvbnMiLCJjYW5Tb3J0T25Kb2luVGFibGVzIiwiX2lkIiwiZmluZCIsInJlc3VsdHMiLCJtYXAiLCJvd25pbmdJZHMiLCJyZWR1Y2VJblJlbGF0aW9uIiwib3JzIiwiYVF1ZXJ5IiwiaW5kZXgiLCJwcm9taXNlcyIsInF1ZXJpZXMiLCJjb25zdHJhaW50S2V5IiwiaXNOZWdhdGlvbiIsInIiLCJxIiwiaWRzIiwiYWRkTm90SW5PYmplY3RJZHNJZHMiLCJhZGRJbk9iamVjdElkc0lkcyIsInJlZHVjZVJlbGF0aW9uS2V5cyIsInJlbGF0ZWRUbyIsImlkc0Zyb21TdHJpbmciLCJpZHNGcm9tRXEiLCJpZHNGcm9tSW4iLCJhbGxJZHMiLCJsaXN0IiwidG90YWxMZW5ndGgiLCJyZWR1Y2UiLCJtZW1vIiwiaWRzSW50ZXJzZWN0aW9uIiwiaW50ZXJzZWN0IiwiYmlnIiwiJGVxIiwiaWRzRnJvbU5pbiIsIlNldCIsIiRuaW4iLCJjb3VudCIsImRpc3RpbmN0IiwicGlwZWxpbmUiLCJyZWFkUHJlZmVyZW5jZSIsIl9jcmVhdGVkX2F0IiwiX3VwZGF0ZWRfYXQiLCJhZ2dyZWdhdGUiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJkZWxldGVTY2hlbWEiLCJkZWxldGVDbGFzcyIsIndhc1BhcnNlQ29sbGVjdGlvbiIsInJlbGF0aW9uRmllbGROYW1lcyIsIm5hbWUiLCJvcGVyYXRpb24iLCJ0ZXN0UGVybWlzc2lvbnNGb3JDbGFzc05hbWUiLCJwZXJtcyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsInVzZXJBQ0wiLCJ1c2VySWQiLCJ1c2VyUG9pbnRlciIsInBlcm1GaWVsZHMiLCJhc3NpZ24iLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCJyZXF1aXJlZFVzZXJGaWVsZHMiLCJkZWZhdWx0Q29sdW1ucyIsIl9EZWZhdWx0IiwiX1VzZXIiLCJyZXF1aXJlZFJvbGVGaWVsZHMiLCJfUm9sZSIsInVzZXJDbGFzc1Byb21pc2UiLCJyb2xlQ2xhc3NQcm9taXNlIiwidXNlcm5hbWVVbmlxdWVuZXNzIiwiZW5zdXJlVW5pcXVlbmVzcyIsImxvZ2dlciIsIndhcm4iLCJlbWFpbFVuaXF1ZW5lc3MiLCJyb2xlVW5pcXVlbmVzcyIsImluZGV4UHJvbWlzZSIsInVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzIiwiYWRhcHRlckluaXQiLCJWb2xhdGlsZUNsYXNzZXNTY2hlbWFzIiwibW9kdWxlIiwiZXhwb3J0cyIsIl92YWxpZGF0ZVF1ZXJ5Il0sIm1hcHBpbmdzIjoiOztBQUtBOztBQUVBOztBQUVBOztBQUVBOztBQUNBOztBQUNBOztBQUNBOzs7Ozs7Ozs7Ozs7OztBQU1BLFNBQVNBLFdBQVQsQ0FBcUJDLEtBQXJCLEVBQTRCQyxHQUE1QixFQUFpQztBQUMvQixRQUFNQyxRQUFRLEdBQUdDLGdCQUFFQyxTQUFGLENBQVlKLEtBQVosQ0FBakIsQ0FEK0IsQ0FFL0I7OztBQUNBRSxFQUFBQSxRQUFRLENBQUNHLE1BQVQsR0FBa0I7QUFBRUMsSUFBQUEsR0FBRyxFQUFFLENBQUMsSUFBRCxFQUFPLEdBQUdMLEdBQVY7QUFBUCxHQUFsQjtBQUNBLFNBQU9DLFFBQVA7QUFDRDs7QUFFRCxTQUFTSyxVQUFULENBQW9CUCxLQUFwQixFQUEyQkMsR0FBM0IsRUFBZ0M7QUFDOUIsUUFBTUMsUUFBUSxHQUFHQyxnQkFBRUMsU0FBRixDQUFZSixLQUFaLENBQWpCLENBRDhCLENBRTlCOzs7QUFDQUUsRUFBQUEsUUFBUSxDQUFDTSxNQUFULEdBQWtCO0FBQUVGLElBQUFBLEdBQUcsRUFBRSxDQUFDLElBQUQsRUFBTyxHQUFQLEVBQVksR0FBR0wsR0FBZjtBQUFQLEdBQWxCO0FBQ0EsU0FBT0MsUUFBUDtBQUNELEMsQ0FFRDs7O0FBQ0EsTUFBTU8sa0JBQWtCLEdBQUcsVUFBd0I7QUFBQSxNQUF2QjtBQUFFQyxJQUFBQTtBQUFGLEdBQXVCO0FBQUEsTUFBYkMsTUFBYTs7QUFDakQsTUFBSSxDQUFDRCxHQUFMLEVBQVU7QUFDUixXQUFPQyxNQUFQO0FBQ0Q7O0FBRURBLEVBQUFBLE1BQU0sQ0FBQ04sTUFBUCxHQUFnQixFQUFoQjtBQUNBTSxFQUFBQSxNQUFNLENBQUNILE1BQVAsR0FBZ0IsRUFBaEI7O0FBRUEsT0FBSyxNQUFNSSxLQUFYLElB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dEssT0FBTCxDQUFhcUoscUJBQWIsQ0FBbUM7QUFDckRrQixNQUFBQSxzQkFBc0IsRUFBRTNKLGdCQUFnQixDQUFDMko7QUFEWSxLQUFuQyxDQUFwQjtBQUdBLFdBQU9oTSxPQUFPLENBQUNtRixHQUFSLENBQVksQ0FDakJvRyxrQkFEaUIsRUFFakJJLGVBRmlCLEVBR2pCQyxjQUhpQixFQUlqQkcsV0FKaUIsRUFLakJGLFlBTGlCLENBQVosQ0FBUDtBQU9EOztBQS9qQ3NCOztBQW9rQ3pCSSxNQUFNLENBQUNDLE9BQVAsR0FBaUIzSyxrQkFBakIsQyxDQUNBOztBQUNBMEssTUFBTSxDQUFDQyxPQUFQLENBQWVDLGNBQWYsR0FBZ0N6UCxhQUFoQyIsInNvdXJjZXNDb250ZW50IjpbIu+7vy8vIEBmbG93XG4vLyBBIGRhdGFiYXNlIGFkYXB0ZXIgdGhhdCB3b3JrcyB3aXRoIGRhdGEgZXhwb3J0ZWQgZnJvbSB0aGUgaG9zdGVkXG4vLyBQYXJzZSBkYXRhYmFzZS5cblxuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgeyBQYXJzZSB9IGZyb20gJ3BhcnNlL25vZGUnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgaW50ZXJzZWN0IGZyb20gJ2ludGVyc2VjdCc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBkZWVwY29weSBmcm9tICdkZWVwY29weSc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uL2xvZ2dlcic7XG5pbXBvcnQgKiBhcyBTY2hlbWFDb250cm9sbGVyIGZyb20gJy4vU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHR5cGUge1xuICBRdWVyeU9wdGlvbnMsXG4gIEZ1bGxRdWVyeU9wdGlvbnMsXG59IGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvU3RvcmFnZUFkYXB0ZXInO1xuXG5mdW5jdGlvbiBhZGRXcml0ZUFDTChxdWVyeSwgYWNsKSB7XG4gIGNvbnN0IG5ld1F1ZXJ5ID0gXy5jbG9uZURlZXAocXVlcnkpO1xuICAvL0Nhbid0IGJlIGFueSBleGlzdGluZyAnX3dwZXJtJyBxdWVyeSwgd2UgZG9uJ3QgYWxsb3cgY2xpZW50IHF1ZXJpZXMgb24gdGhhdCwgbm8gbmVlZCB0byAkYW5kXG4gIG5ld1F1ZXJ5Ll93cGVybSA9IHsgJGluOiBbbnVsbCwgLi4uYWNsXSB9O1xuICByZXR1cm4gbmV3UXVlcnk7XG59XG5cbmZ1bmN0aW9uIGFkZFJlYWRBQ0wocXVlcnksIGFjbCkge1xuICBjb25zdCBuZXdRdWVyeSA9IF8uY2xvbmVEZWVwKHF1ZXJ5KTtcbiAgLy9DYW4ndCBiZSBhbnkgZXhpc3RpbmcgJ19ycGVybScgcXVlcnksIHdlIGRvbid0IGFsbG93IGNsaWVudCBxdWVyaWVzIG9uIHRoYXQsIG5vIG5lZWQgdG8gJGFuZFxuICBuZXdRdWVyeS5fcnBlcm0gPSB7ICRpbjogW251bGwsICcqJywgLi4uYWNsXSB9O1xuICByZXR1cm4gbmV3UXVlcnk7XG59XG5cbi8vIFRyYW5zZm9ybXMgYSBSRVNUIEFQSSBmb3JtYXR0ZWQgQUNMIG9iamVjdCB0byBvdXIgdHdvLWZpZWxkIG1vbmdvIGZvcm1hdC5cbmNvbnN0IHRyYW5zZm9ybU9iamVjdEFDTCA9ICh7IEFDTCwgLi4ucmVzdWx0IH0pID0+IHtcbiAgaWYgKCFBQ0wpIHtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgcmVzdWx0Ll93cGVybSA9IFtdO1xuICByZXN1bHQuX3JwZXJtID0gW107XG5cbiAgZm9yIChjb25zdCBlbnRyeSBpbiBBQ0wpIHtcbiAgICBpZiAoQUNMW2VudHJ5XS5yZWFkKSB7XG4gICAgICByZXN1bHQuX3JwZXJtLnB1c2goZW50cnkpO1xuICAgIH1cbiAgICBpZiAoQUNMW2VudHJ5XS53cml0ZSkge1xuICAgICAgcmVzdWx0Ll93cGVybS5wdXNoKGVudHJ5KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJlc3VsdDtcbn07XG5cbmNvbnN0IHNwZWNpYWxRdWVyeWtleXMgPSBbXG4gICckYW5kJyxcbiAgJyRvcicsXG4gICckbm9yJyxcbiAgJ19ycGVybScsXG4gICdfd3Blcm0nLFxuICAnX3BlcmlzaGFibGVfdG9rZW4nLFxuICAnX2VtYWlsX3ZlcmlmeV90b2tlbicsXG4gICdfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQnLFxuICAnX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0JyxcbiAgJ19mYWlsZWRfbG9naW5fY291bnQnLFxuXTtcblxuY29uc3QgaXNTcGVjaWFsUXVlcnlLZXkgPSBrZXkgPT4ge1xuICByZXR1cm4gc3BlY2lhbFF1ZXJ5a2V5cy5pbmRleE9mKGtleSkgPj0gMDtcbn07XG5cbmNvbnN0IHZhbGlkYXRlUXVlcnkgPSAocXVlcnk6IGFueSk6IHZvaWQgPT4ge1xuICBpZiAocXVlcnkuQUNMKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksICdDYW5ub3QgcXVlcnkgb24gQUNMLicpO1xuICB9XG5cbiAgaWYgKHF1ZXJ5LiRvcikge1xuICAgIGlmIChxdWVyeS4kb3IgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgcXVlcnkuJG9yLmZvckVhY2godmFsaWRhdGVRdWVyeSk7XG5cbiAgICAgIC8qIEluIE1vbmdvREIsICRvciBxdWVyaWVzIHdoaWNoIGFyZSBub3QgYWxvbmUgYXQgdGhlIHRvcCBsZXZlbCBvZiB0aGVcbiAgICAgICAqIHF1ZXJ5IGNhbiBub3QgbWFrZSBlZmZpY2llbnQgdXNlIG9mIGluZGV4ZXMgZHVlIHRvIGEgbG9uZyBzdGFuZGluZ1xuICAgICAgICogYnVnIGtub3duIGFzIFNFUlZFUi0xMzczMi5cbiAgICAgICAqXG4gICAgICAgKiBUaGlzIGJsb2NrIHJlc3RydWN0dXJlcyBxdWVyaWVzIGluIHdoaWNoICRvciBpcyBub3QgdGhlIHNvbGUgdG9wXG4gICAgICAgKiBsZXZlbCBlbGVtZW50IGJ5IG1vdmluZyBhbGwgb3RoZXIgdG9wLWxldmVsIHByZWRpY2F0ZXMgaW5zaWRlIGV2ZXJ5XG4gICAgICAgKiBzdWJkb2N1bWVudCBvZiB0aGUgJG9yIHByZWRpY2F0ZSwgYWxsb3dpbmcgTW9uZ29EQidzIHF1ZXJ5IHBsYW5uZXJcbiAgICAgICAqIHRvIG1ha2UgZnVsbCB1c2Ugb2YgdGhlIG1vc3QgcmVsZXZhbnQgaW5kZXhlcy5cbiAgICAgICAqXG4gICAgICAgKiBFRzogICAgICB7JG9yOiBbe2E6IDF9LCB7YTogMn1dLCBiOiAyfVxuICAgICAgICogQmVjb21lczogeyRvcjogW3thOiAxLCBiOiAyfSwge2E6IDIsIGI6IDJ9XX1cbiAgICAgICAqXG4gICAgICAgKiBUaGUgb25seSBleGNlcHRpb25zIGFyZSAkbmVhciBhbmQgJG5lYXJTcGhlcmUgb3BlcmF0b3JzLCB3aGljaCBhcmVcbiAgICAgICAqIGNvbnN0cmFpbmVkIHRvIG9ubHkgMSBvcGVyYXRvciBwZXIgcXVlcnkuIEFzIGEgcmVzdWx0LCB0aGVzZSBvcHNcbiAgICAgICAqIHJlbWFpbiBhdCB0aGUgdG9wIGxldmVsXG4gICAgICAgKlxuICAgICAgICogaHR0cHM6Ly9qaXJhLm1vbmdvZGIub3JnL2Jyb3dzZS9TRVJWRVItMTM3MzJcbiAgICAgICAqIGh0dHBzOi8vZ2l0aHViLmNvbS9wYXJzZS1jb21tdW5pdHkvcGFyc2Utc2VydmVyL2lzc3Vlcy8zNzY3XG4gICAgICAgKi9cbiAgICAgIE9iamVjdC5rZXlzKHF1ZXJ5KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgIGNvbnN0IG5vQ29sbGlzaW9ucyA9ICFxdWVyeS4kb3Iuc29tZShzdWJxID0+IHN1YnEuaGFzT3duUHJvcGVydHkoa2V5KSk7XG4gICAgICAgIGxldCBoYXNOZWFycyA9IGZhbHNlO1xuICAgICAgICBpZiAocXVlcnlba2V5XSAhPSBudWxsICYmIHR5cGVvZiBxdWVyeVtrZXldID09ICdvYmplY3QnKSB7XG4gICAgICAgICAgaGFzTmVhcnMgPSAnJG5lYXInIGluIHF1ZXJ5W2tleV0gfHwgJyRuZWFyU3BoZXJlJyBpbiBxdWVyeVtrZXldO1xuICAgICAgICB9XG4gICAgICAgIGlmIChrZXkgIT0gJyRvcicgJiYgbm9Db2xsaXNpb25zICYmICFoYXNOZWFycykge1xuICAgICAgICAgIHF1ZXJ5LiRvci5mb3JFYWNoKHN1YnF1ZXJ5ID0+IHtcbiAgICAgICAgICAgIHN1YnF1ZXJ5W2tleV0gPSBxdWVyeVtrZXldO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIGRlbGV0ZSBxdWVyeVtrZXldO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHF1ZXJ5LiRvci5mb3JFYWNoKHZhbGlkYXRlUXVlcnkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICdCYWQgJG9yIGZvcm1hdCAtIHVzZSBhbiBhcnJheSB2YWx1ZS4nXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGlmIChxdWVyeS4kYW5kKSB7XG4gICAgaWYgKHF1ZXJ5LiRhbmQgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgcXVlcnkuJGFuZC5mb3JFYWNoKHZhbGlkYXRlUXVlcnkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICdCYWQgJGFuZCBmb3JtYXQgLSB1c2UgYW4gYXJyYXkgdmFsdWUuJ1xuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAocXVlcnkuJG5vcikge1xuICAgIGlmIChxdWVyeS4kbm9yIGluc3RhbmNlb2YgQXJyYXkgJiYgcXVlcnkuJG5vci5sZW5ndGggPiAwKSB7XG4gICAgICBxdWVyeS4kbm9yLmZvckVhY2godmFsaWRhdGVRdWVyeSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgJ0JhZCAkbm9yIGZvcm1hdCAtIHVzZSBhbiBhcnJheSBvZiBhdCBsZWFzdCAxIHZhbHVlLidcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgT2JqZWN0LmtleXMocXVlcnkpLmZvckVhY2goa2V5ID0+IHtcbiAgICBpZiAocXVlcnkgJiYgcXVlcnlba2V5XSAmJiBxdWVyeVtrZXldLiRyZWdleCkge1xuICAgICAgaWYgKHR5cGVvZiBxdWVyeVtrZXldLiRvcHRpb25zID09PSAnc3RyaW5nJykge1xuICAgICAgICBpZiAoIXF1ZXJ5W2tleV0uJG9wdGlvbnMubWF0Y2goL15baW14c10rJC8pKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICAgIGBCYWQgJG9wdGlvbnMgdmFsdWUgZm9yIHF1ZXJ5OiAke3F1ZXJ5W2tleV0uJG9wdGlvbnN9YFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFpc1NwZWNpYWxRdWVyeUtleShrZXkpICYmICFrZXkubWF0Y2goL15bYS16QS1aXVthLXpBLVowLTlfXFwuXSokLykpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICAgYEludmFsaWQga2V5IG5hbWU6ICR7a2V5fWBcbiAgICAgICk7XG4gICAgfVxuICB9KTtcbn07XG5cbi8vIEZpbHRlcnMgb3V0IGFueSBkYXRhIHRoYXQgc2hvdWxkbid0IGJlIG9uIHRoaXMgUkVTVC1mb3JtYXR0ZWQgb2JqZWN0LlxuY29uc3QgZmlsdGVyU2Vuc2l0aXZlRGF0YSA9IChpc01hc3RlciwgYWNsR3JvdXAsIGNsYXNzTmFtZSwgb2JqZWN0KSA9PiB7XG4gIGlmIChjbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgb2JqZWN0LnBhc3N3b3JkID0gb2JqZWN0Ll9oYXNoZWRfcGFzc3dvcmQ7XG4gIGRlbGV0ZSBvYmplY3QuX2hhc2hlZF9wYXNzd29yZDtcblxuICBkZWxldGUgb2JqZWN0LnNlc3Npb25Ub2tlbjtcblxuICBpZiAoaXNNYXN0ZXIpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIGRlbGV0ZSBvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbjtcbiAgZGVsZXRlIG9iamVjdC5fcGVyaXNoYWJsZV90b2tlbjtcbiAgZGVsZXRlIG9iamVjdC5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0O1xuICBkZWxldGUgb2JqZWN0Ll90b21ic3RvbmU7XG4gIGRlbGV0ZSBvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0O1xuICBkZWxldGUgb2JqZWN0Ll9mYWlsZWRfbG9naW5fY291bnQ7XG4gIGRlbGV0ZSBvYmplY3QuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0O1xuICBkZWxldGUgb2JqZWN0Ll9wYXNzd29yZF9jaGFuZ2VkX2F0O1xuICBkZWxldGUgb2JqZWN0Ll9wYXNzd29yZF9oaXN0b3J5O1xuXG4gIGlmIChhY2xHcm91cC5pbmRleE9mKG9iamVjdC5vYmplY3RJZCkgPiAtMSkge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cbiAgZGVsZXRlIG9iamVjdC5hdXRoRGF0YTtcbiAgcmV0dXJuIG9iamVjdDtcbn07XG5cbmltcG9ydCB0eXBlIHsgTG9hZFNjaGVtYU9wdGlvbnMgfSBmcm9tICcuL3R5cGVzJztcblxuLy8gUnVucyBhbiB1cGRhdGUgb24gdGhlIGRhdGFiYXNlLlxuLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIGFuIG9iamVjdCB3aXRoIHRoZSBuZXcgdmFsdWVzIGZvciBmaWVsZFxuLy8gbW9kaWZpY2F0aW9ucyB0aGF0IGRvbid0IGtub3cgdGhlaXIgcmVzdWx0cyBhaGVhZCBvZiB0aW1lLCBsaWtlXG4vLyAnaW5jcmVtZW50Jy5cbi8vIE9wdGlvbnM6XG4vLyAgIGFjbDogIGEgbGlzdCBvZiBzdHJpbmdzLiBJZiB0aGUgb2JqZWN0IHRvIGJlIHVwZGF0ZWQgaGFzIGFuIEFDTCxcbi8vICAgICAgICAgb25lIG9mIHRoZSBwcm92aWRlZCBzdHJpbmdzIG11c3QgcHJvdmlkZSB0aGUgY2FsbGVyIHdpdGhcbi8vICAgICAgICAgd3JpdGUgcGVybWlzc2lvbnMuXG5jb25zdCBzcGVjaWFsS2V5c0ZvclVwZGF0ZSA9IFtcbiAgJ19oYXNoZWRfcGFzc3dvcmQnLFxuICAnX3BlcmlzaGFibGVfdG9rZW4nLFxuICAnX2VtYWlsX3ZlcmlmeV90b2tlbicsXG4gICdfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQnLFxuICAnX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0JyxcbiAgJ19mYWlsZWRfbG9naW5fY291bnQnLFxuICAnX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCcsXG4gICdfcGFzc3dvcmRfY2hhbmdlZF9hdCcsXG4gICdfcGFzc3dvcmRfaGlzdG9yeScsXG5dO1xuXG5jb25zdCBpc1NwZWNpYWxVcGRhdGVLZXkgPSBrZXkgPT4ge1xuICByZXR1cm4gc3BlY2lhbEtleXNGb3JVcGRhdGUuaW5kZXhPZihrZXkpID49IDA7XG59O1xuXG5mdW5jdGlvbiBleHBhbmRSZXN1bHRPbktleVBhdGgob2JqZWN0LCBrZXksIHZhbHVlKSB7XG4gIGlmIChrZXkuaW5kZXhPZignLicpIDwgMCkge1xuICAgIG9iamVjdFtrZXldID0gdmFsdWVba2V5XTtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIGNvbnN0IHBhdGggPSBrZXkuc3BsaXQoJy4nKTtcbiAgY29uc3QgZmlyc3RLZXkgPSBwYXRoWzBdO1xuICBjb25zdCBuZXh0UGF0aCA9IHBhdGguc2xpY2UoMSkuam9pbignLicpO1xuICBvYmplY3RbZmlyc3RLZXldID0gZXhwYW5kUmVzdWx0T25LZXlQYXRoKFxuICAgIG9iamVjdFtmaXJzdEtleV0gfHwge30sXG4gICAgbmV4dFBhdGgsXG4gICAgdmFsdWVbZmlyc3RLZXldXG4gICk7XG4gIGRlbGV0ZSBvYmplY3Rba2V5XTtcbiAgcmV0dXJuIG9iamVjdDtcbn1cblxuZnVuY3Rpb24gc2FuaXRpemVEYXRhYmFzZVJlc3VsdChvcmlnaW5hbE9iamVjdCwgcmVzdWx0KTogUHJvbWlzZTxhbnk+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSB7fTtcbiAgaWYgKCFyZXN1bHQpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHJlc3BvbnNlKTtcbiAgfVxuICBPYmplY3Qua2V5cyhvcmlnaW5hbE9iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgIGNvbnN0IGtleVVwZGF0ZSA9IG9yaWdpbmFsT2JqZWN0W2tleV07XG4gICAgLy8gZGV0ZXJtaW5lIGlmIHRoYXQgd2FzIGFuIG9wXG4gICAgaWYgKFxuICAgICAga2V5VXBkYXRlICYmXG4gICAgICB0eXBlb2Yga2V5VXBkYXRlID09PSAnb2JqZWN0JyAmJlxuICAgICAga2V5VXBkYXRlLl9fb3AgJiZcbiAgICAgIFsnQWRkJywgJ0FkZFVuaXF1ZScsICdSZW1vdmUnLCAnSW5jcmVtZW50J10uaW5kZXhPZihrZXlVcGRhdGUuX19vcCkgPiAtMVxuICAgICkge1xuICAgICAgLy8gb25seSB2YWxpZCBvcHMgdGhhdCBwcm9kdWNlIGFuIGFjdGlvbmFibGUgcmVzdWx0XG4gICAgICAvLyB0aGUgb3AgbWF5IGhhdmUgaGFwcGVuZCBvbiBhIGtleXBhdGhcbiAgICAgIGV4cGFuZFJlc3VsdE9uS2V5UGF0aChyZXNwb25zZSwga2V5LCByZXN1bHQpO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzcG9uc2UpO1xufVxuXG5mdW5jdGlvbiBqb2luVGFibGVOYW1lKGNsYXNzTmFtZSwga2V5KSB7XG4gIHJldHVybiBgX0pvaW46JHtrZXl9OiR7Y2xhc3NOYW1lfWA7XG59XG5cbmNvbnN0IGZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUgPSBvYmplY3QgPT4ge1xuICBmb3IgKGNvbnN0IGtleSBpbiBvYmplY3QpIHtcbiAgICBpZiAob2JqZWN0W2tleV0gJiYgb2JqZWN0W2tleV0uX19vcCkge1xuICAgICAgc3dpdGNoIChvYmplY3Rba2V5XS5fX29wKSB7XG4gICAgICAgIGNhc2UgJ0luY3JlbWVudCc6XG4gICAgICAgICAgaWYgKHR5cGVvZiBvYmplY3Rba2V5XS5hbW91bnQgIT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3Rba2V5XSA9IG9iamVjdFtrZXldLmFtb3VudDtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnQWRkJzpcbiAgICAgICAgICBpZiAoIShvYmplY3Rba2V5XS5vYmplY3RzIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3Rba2V5XSA9IG9iamVjdFtrZXldLm9iamVjdHM7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0FkZFVuaXF1ZSc6XG4gICAgICAgICAgaWYgKCEob2JqZWN0W2tleV0ub2JqZWN0cyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5J1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5vYmplY3RzO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdSZW1vdmUnOlxuICAgICAgICAgIGlmICghKG9iamVjdFtrZXldLm9iamVjdHMgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgICAnb2JqZWN0cyB0byBhZGQgbXVzdCBiZSBhbiBhcnJheSdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9iamVjdFtrZXldID0gW107XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0RlbGV0ZSc6XG4gICAgICAgICAgZGVsZXRlIG9iamVjdFtrZXldO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkNPTU1BTkRfVU5BVkFJTEFCTEUsXG4gICAgICAgICAgICBgVGhlICR7b2JqZWN0W2tleV0uX19vcH0gb3BlcmF0b3IgaXMgbm90IHN1cHBvcnRlZCB5ZXQuYFxuICAgICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1BdXRoRGF0YSA9IChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSA9PiB7XG4gIGlmIChvYmplY3QuYXV0aERhdGEgJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgT2JqZWN0LmtleXMob2JqZWN0LmF1dGhEYXRhKS5mb3JFYWNoKHByb3ZpZGVyID0+IHtcbiAgICAgIGNvbnN0IHByb3ZpZGVyRGF0YSA9IG9iamVjdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICBjb25zdCBmaWVsZE5hbWUgPSBgX2F1dGhfZGF0YV8ke3Byb3ZpZGVyfWA7XG4gICAgICBpZiAocHJvdmlkZXJEYXRhID09IG51bGwpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX19vcDogJ0RlbGV0ZScsXG4gICAgICAgIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHByb3ZpZGVyRGF0YTtcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdID0geyB0eXBlOiAnT2JqZWN0JyB9O1xuICAgICAgfVxuICAgIH0pO1xuICAgIGRlbGV0ZSBvYmplY3QuYXV0aERhdGE7XG4gIH1cbn07XG4vLyBUcmFuc2Zvcm1zIGEgRGF0YWJhc2UgZm9ybWF0IEFDTCB0byBhIFJFU1QgQVBJIGZvcm1hdCBBQ0xcbmNvbnN0IHVudHJhbnNmb3JtT2JqZWN0QUNMID0gKHsgX3JwZXJtLCBfd3Blcm0sIC4uLm91dHB1dCB9KSA9PiB7XG4gIGlmIChfcnBlcm0gfHwgX3dwZXJtKSB7XG4gICAgb3V0cHV0LkFDTCA9IHt9O1xuXG4gICAgKF9ycGVybSB8fCBbXSkuZm9yRWFjaChlbnRyeSA9PiB7XG4gICAgICBpZiAoIW91dHB1dC5BQ0xbZW50cnldKSB7XG4gICAgICAgIG91dHB1dC5BQ0xbZW50cnldID0geyByZWFkOiB0cnVlIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvdXRwdXQuQUNMW2VudHJ5XVsncmVhZCddID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIChfd3Blcm0gfHwgW10pLmZvckVhY2goZW50cnkgPT4ge1xuICAgICAgaWYgKCFvdXRwdXQuQUNMW2VudHJ5XSkge1xuICAgICAgICBvdXRwdXQuQUNMW2VudHJ5XSA9IHsgd3JpdGU6IHRydWUgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG91dHB1dC5BQ0xbZW50cnldWyd3cml0ZSddID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICByZXR1cm4gb3V0cHV0O1xufTtcblxuLyoqXG4gKiBXaGVuIHF1ZXJ5aW5nLCB0aGUgZmllbGROYW1lIG1heSBiZSBjb21wb3VuZCwgZXh0cmFjdCB0aGUgcm9vdCBmaWVsZE5hbWVcbiAqICAgICBgdGVtcGVyYXR1cmUuY2Vsc2l1c2AgYmVjb21lcyBgdGVtcGVyYXR1cmVgXG4gKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIHRoYXQgbWF5IGJlIGEgY29tcG91bmQgZmllbGQgbmFtZVxuICogQHJldHVybnMge3N0cmluZ30gdGhlIHJvb3QgbmFtZSBvZiB0aGUgZmllbGRcbiAqL1xuY29uc3QgZ2V0Um9vdEZpZWxkTmFtZSA9IChmaWVsZE5hbWU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gIHJldHVybiBmaWVsZE5hbWUuc3BsaXQoJy4nKVswXTtcbn07XG5cbmNvbnN0IHJlbGF0aW9uU2NoZW1hID0ge1xuICBmaWVsZHM6IHsgcmVsYXRlZElkOiB7IHR5cGU6ICdTdHJpbmcnIH0sIG93bmluZ0lkOiB7IHR5cGU6ICdTdHJpbmcnIH0gfSxcbn07XG5cbmNsYXNzIERhdGFiYXNlQ29udHJvbGxlciB7XG4gIGFkYXB0ZXI6IFN0b3JhZ2VBZGFwdGVyO1xuICBzY2hlbWFDYWNoZTogYW55O1xuICBzY2hlbWFQcm9taXNlOiA/UHJvbWlzZTxTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXI+O1xuXG4gIGNvbnN0cnVjdG9yKGFkYXB0ZXI6IFN0b3JhZ2VBZGFwdGVyLCBzY2hlbWFDYWNoZTogYW55KSB7XG4gICAgdGhpcy5hZGFwdGVyID0gYWRhcHRlcjtcbiAgICB0aGlzLnNjaGVtYUNhY2hlID0gc2NoZW1hQ2FjaGU7XG4gICAgLy8gV2UgZG9uJ3Qgd2FudCBhIG11dGFibGUgdGhpcy5zY2hlbWEsIGJlY2F1c2UgdGhlbiB5b3UgY291bGQgaGF2ZVxuICAgIC8vIG9uZSByZXF1ZXN0IHRoYXQgdXNlcyBkaWZmZXJlbnQgc2NoZW1hcyBmb3IgZGlmZmVyZW50IHBhcnRzIG9mXG4gICAgLy8gaXQuIEluc3RlYWQsIHVzZSBsb2FkU2NoZW1hIHRvIGdldCBhIHNjaGVtYS5cbiAgICB0aGlzLnNjaGVtYVByb21pc2UgPSBudWxsO1xuICB9XG5cbiAgY29sbGVjdGlvbkV4aXN0cyhjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuY2xhc3NFeGlzdHMoY2xhc3NOYW1lKTtcbiAgfVxuXG4gIHB1cmdlQ29sbGVjdGlvbihjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEoKVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUpKVxuICAgICAgLnRoZW4oc2NoZW1hID0+IHRoaXMuYWRhcHRlci5kZWxldGVPYmplY3RzQnlRdWVyeShjbGFzc05hbWUsIHNjaGVtYSwge30pKTtcbiAgfVxuXG4gIHZhbGlkYXRlQ2xhc3NOYW1lKGNsYXNzTmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCFTY2hlbWFDb250cm9sbGVyLmNsYXNzTmFtZUlzVmFsaWQoY2xhc3NOYW1lKSkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9DTEFTU19OQU1FLFxuICAgICAgICAgICdpbnZhbGlkIGNsYXNzTmFtZTogJyArIGNsYXNzTmFtZVxuICAgICAgICApXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSBzY2hlbWFDb250cm9sbGVyLlxuICBsb2FkU2NoZW1hKFxuICAgIG9wdGlvbnM6IExvYWRTY2hlbWFPcHRpb25zID0geyBjbGVhckNhY2hlOiBmYWxzZSB9XG4gICk6IFByb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPiB7XG4gICAgaWYgKHRoaXMuc2NoZW1hUHJvbWlzZSAhPSBudWxsKSB7XG4gICAgICByZXR1cm4gdGhpcy5zY2hlbWFQcm9taXNlO1xuICAgIH1cbiAgICB0aGlzLnNjaGVtYVByb21pc2UgPSBTY2hlbWFDb250cm9sbGVyLmxvYWQoXG4gICAgICB0aGlzLmFkYXB0ZXIsXG4gICAgICB0aGlzLnNjaGVtYUNhY2hlLFxuICAgICAgb3B0aW9uc1xuICAgICk7XG4gICAgdGhpcy5zY2hlbWFQcm9taXNlLnRoZW4oXG4gICAgICAoKSA9PiBkZWxldGUgdGhpcy5zY2hlbWFQcm9taXNlLFxuICAgICAgKCkgPT4gZGVsZXRlIHRoaXMuc2NoZW1hUHJvbWlzZVxuICAgICk7XG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYShvcHRpb25zKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciB0aGUgY2xhc3NuYW1lIHRoYXQgaXMgcmVsYXRlZCB0byB0aGUgZ2l2ZW5cbiAgLy8gY2xhc3NuYW1lIHRocm91Z2ggdGhlIGtleS5cbiAgLy8gVE9ETzogbWFrZSB0aGlzIG5vdCBpbiB0aGUgRGF0YWJhc2VDb250cm9sbGVyIGludGVyZmFjZVxuICByZWRpcmVjdENsYXNzTmFtZUZvcktleShjbGFzc05hbWU6IHN0cmluZywga2V5OiBzdHJpbmcpOiBQcm9taXNlPD9zdHJpbmc+IHtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT4ge1xuICAgICAgdmFyIHQgPSBzY2hlbWEuZ2V0RXhwZWN0ZWRUeXBlKGNsYXNzTmFtZSwga2V5KTtcbiAgICAgIGlmICh0ICE9IG51bGwgJiYgdHlwZW9mIHQgIT09ICdzdHJpbmcnICYmIHQudHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICByZXR1cm4gdC50YXJnZXRDbGFzcztcbiAgICAgIH1cbiAgICAgIHJldHVybiBjbGFzc05hbWU7XG4gICAgfSk7XG4gIH1cblxuICAvLyBVc2VzIHRoZSBzY2hlbWEgdG8gdmFsaWRhdGUgdGhlIG9iamVjdCAoUkVTVCBBUEkgZm9ybWF0KS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbmV3IHNjaGVtYS5cbiAgLy8gVGhpcyBkb2VzIG5vdCB1cGRhdGUgdGhpcy5zY2hlbWEsIGJlY2F1c2UgaW4gYSBzaXR1YXRpb24gbGlrZSBhXG4gIC8vIGJhdGNoIHJlcXVlc3QsIHRoYXQgY291bGQgY29uZnVzZSBvdGhlciB1c2VycyBvZiB0aGUgc2NoZW1hLlxuICB2YWxpZGF0ZU9iamVjdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3Q6IGFueSxcbiAgICBxdWVyeTogYW55LFxuICAgIHsgYWNsIH06IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBsZXQgc2NoZW1hO1xuICAgIGNvbnN0IGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQ7XG4gICAgdmFyIGFjbEdyb3VwOiBzdHJpbmdbXSA9IGFjbCB8fCBbXTtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKClcbiAgICAgIC50aGVuKHMgPT4ge1xuICAgICAgICBzY2hlbWEgPSBzO1xuICAgICAgICBpZiAoaXNNYXN0ZXIpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FuQWRkRmllbGQoc2NoZW1hLCBjbGFzc05hbWUsIG9iamVjdCwgYWNsR3JvdXApO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHNjaGVtYS52YWxpZGF0ZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgcXVlcnkpO1xuICAgICAgfSk7XG4gIH1cblxuICB1cGRhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB7IGFjbCwgbWFueSwgdXBzZXJ0IH06IEZ1bGxRdWVyeU9wdGlvbnMgPSB7fSxcbiAgICBza2lwU2FuaXRpemF0aW9uOiBib29sZWFuID0gZmFsc2VcbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCBvcmlnaW5hbFF1ZXJ5ID0gcXVlcnk7XG4gICAgY29uc3Qgb3JpZ2luYWxVcGRhdGUgPSB1cGRhdGU7XG4gICAgLy8gTWFrZSBhIGNvcHkgb2YgdGhlIG9iamVjdCwgc28gd2UgZG9uJ3QgbXV0YXRlIHRoZSBpbmNvbWluZyBkYXRhLlxuICAgIHVwZGF0ZSA9IGRlZXBjb3B5KHVwZGF0ZSk7XG4gICAgdmFyIHJlbGF0aW9uVXBkYXRlcyA9IFtdO1xuICAgIHZhciBpc01hc3RlciA9IGFjbCA9PT0gdW5kZWZpbmVkO1xuICAgIHZhciBhY2xHcm91cCA9IGFjbCB8fCBbXTtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgIHJldHVybiAoaXNNYXN0ZXJcbiAgICAgICAgPyBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICd1cGRhdGUnKVxuICAgICAgKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgcmVsYXRpb25VcGRhdGVzID0gdGhpcy5jb2xsZWN0UmVsYXRpb25VcGRhdGVzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgb3JpZ2luYWxRdWVyeS5vYmplY3RJZCxcbiAgICAgICAgICAgIHVwZGF0ZVxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAndXBkYXRlJyxcbiAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoIXF1ZXJ5KSB7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChhY2wpIHtcbiAgICAgICAgICAgIHF1ZXJ5ID0gYWRkV3JpdGVBQ0wocXVlcnksIGFjbCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHZhbGlkYXRlUXVlcnkocXVlcnkpO1xuICAgICAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgICAgICAuZ2V0T25lU2NoZW1hKGNsYXNzTmFtZSwgdHJ1ZSlcbiAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgIC8vIElmIHRoZSBzY2hlbWEgZG9lc24ndCBleGlzdCwgcHJldGVuZCBpdCBleGlzdHMgd2l0aCBubyBmaWVsZHMuIFRoaXMgYmVoYXZpb3JcbiAgICAgICAgICAgICAgLy8gd2lsbCBsaWtlbHkgbmVlZCByZXZpc2l0aW5nLlxuICAgICAgICAgICAgICBpZiAoZXJyb3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7IGZpZWxkczoge30gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAudGhlbihzY2hlbWEgPT4ge1xuICAgICAgICAgICAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGROYW1lLm1hdGNoKC9eYXV0aERhdGFcXC4oW2EtekEtWjAtOV9dKylcXC5pZCQvKSkge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCBmaWVsZCBuYW1lIGZvciB1cGRhdGU6ICR7ZmllbGROYW1lfWBcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHJvb3RGaWVsZE5hbWUgPSBnZXRSb290RmllbGROYW1lKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lKSAmJlxuICAgICAgICAgICAgICAgICAgIWlzU3BlY2lhbFVwZGF0ZUtleShyb290RmllbGROYW1lKVxuICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgICAgICBgSW52YWxpZCBmaWVsZCBuYW1lIGZvciB1cGRhdGU6ICR7ZmllbGROYW1lfWBcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB1cGRhdGVPcGVyYXRpb24gaW4gdXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgICAgdXBkYXRlW3VwZGF0ZU9wZXJhdGlvbl0gJiZcbiAgICAgICAgICAgICAgICAgIHR5cGVvZiB1cGRhdGVbdXBkYXRlT3BlcmF0aW9uXSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgICAgICAgICAgIE9iamVjdC5rZXlzKHVwZGF0ZVt1cGRhdGVPcGVyYXRpb25dKS5zb21lKFxuICAgICAgICAgICAgICAgICAgICBpbm5lcktleSA9PiBpbm5lcktleS5pbmNsdWRlcygnJCcpIHx8IGlubmVyS2V5LmluY2x1ZGVzKCcuJylcbiAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9ORVNURURfS0VZLFxuICAgICAgICAgICAgICAgICAgICBcIk5lc3RlZCBrZXlzIHNob3VsZCBub3QgY29udGFpbiB0aGUgJyQnIG9yICcuJyBjaGFyYWN0ZXJzXCJcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHVwZGF0ZSA9IHRyYW5zZm9ybU9iamVjdEFDTCh1cGRhdGUpO1xuICAgICAgICAgICAgICB0cmFuc2Zvcm1BdXRoRGF0YShjbGFzc05hbWUsIHVwZGF0ZSwgc2NoZW1hKTtcbiAgICAgICAgICAgICAgaWYgKG1hbnkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLnVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICB1cGRhdGVcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9IGVsc2UgaWYgKHVwc2VydCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICB1cGRhdGVcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZmluZE9uZUFuZFVwZGF0ZShcbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgdXBkYXRlXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKChyZXN1bHQ6IGFueSkgPT4ge1xuICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0aGlzLmhhbmRsZVJlbGF0aW9uVXBkYXRlcyhcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIG9yaWdpbmFsUXVlcnkub2JqZWN0SWQsXG4gICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICByZWxhdGlvblVwZGF0ZXNcbiAgICAgICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgICBpZiAoc2tpcFNhbml0aXphdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gc2FuaXRpemVEYXRhYmFzZVJlc3VsdChvcmlnaW5hbFVwZGF0ZSwgcmVzdWx0KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBDb2xsZWN0IGFsbCByZWxhdGlvbi11cGRhdGluZyBvcGVyYXRpb25zIGZyb20gYSBSRVNULWZvcm1hdCB1cGRhdGUuXG4gIC8vIFJldHVybnMgYSBsaXN0IG9mIGFsbCByZWxhdGlvbiB1cGRhdGVzIHRvIHBlcmZvcm1cbiAgLy8gVGhpcyBtdXRhdGVzIHVwZGF0ZS5cbiAgY29sbGVjdFJlbGF0aW9uVXBkYXRlcyhjbGFzc05hbWU6IHN0cmluZywgb2JqZWN0SWQ6ID9zdHJpbmcsIHVwZGF0ZTogYW55KSB7XG4gICAgdmFyIG9wcyA9IFtdO1xuICAgIHZhciBkZWxldGVNZSA9IFtdO1xuICAgIG9iamVjdElkID0gdXBkYXRlLm9iamVjdElkIHx8IG9iamVjdElkO1xuXG4gICAgdmFyIHByb2Nlc3MgPSAob3AsIGtleSkgPT4ge1xuICAgICAgaWYgKCFvcCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAob3AuX19vcCA9PSAnQWRkUmVsYXRpb24nKSB7XG4gICAgICAgIG9wcy5wdXNoKHsga2V5LCBvcCB9KTtcbiAgICAgICAgZGVsZXRlTWUucHVzaChrZXkpO1xuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnUmVtb3ZlUmVsYXRpb24nKSB7XG4gICAgICAgIG9wcy5wdXNoKHsga2V5LCBvcCB9KTtcbiAgICAgICAgZGVsZXRlTWUucHVzaChrZXkpO1xuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnQmF0Y2gnKSB7XG4gICAgICAgIGZvciAodmFyIHggb2Ygb3Aub3BzKSB7XG4gICAgICAgICAgcHJvY2Vzcyh4LCBrZXkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcblxuICAgIGZvciAoY29uc3Qga2V5IGluIHVwZGF0ZSkge1xuICAgICAgcHJvY2Vzcyh1cGRhdGVba2V5XSwga2V5KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBrZXkgb2YgZGVsZXRlTWUpIHtcbiAgICAgIGRlbGV0ZSB1cGRhdGVba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIG9wcztcbiAgfVxuXG4gIC8vIFByb2Nlc3NlcyByZWxhdGlvbi11cGRhdGluZyBvcGVyYXRpb25zIGZyb20gYSBSRVNULWZvcm1hdCB1cGRhdGUuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBhbGwgdXBkYXRlcyBoYXZlIGJlZW4gcGVyZm9ybWVkXG4gIGhhbmRsZVJlbGF0aW9uVXBkYXRlcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3RJZDogc3RyaW5nLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIG9wczogYW55XG4gICkge1xuICAgIHZhciBwZW5kaW5nID0gW107XG4gICAgb2JqZWN0SWQgPSB1cGRhdGUub2JqZWN0SWQgfHwgb2JqZWN0SWQ7XG4gICAgb3BzLmZvckVhY2goKHsga2V5LCBvcCB9KSA9PiB7XG4gICAgICBpZiAoIW9wKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChvcC5fX29wID09ICdBZGRSZWxhdGlvbicpIHtcbiAgICAgICAgZm9yIChjb25zdCBvYmplY3Qgb2Ygb3Aub2JqZWN0cykge1xuICAgICAgICAgIHBlbmRpbmcucHVzaChcbiAgICAgICAgICAgIHRoaXMuYWRkUmVsYXRpb24oa2V5LCBjbGFzc05hbWUsIG9iamVjdElkLCBvYmplY3Qub2JqZWN0SWQpXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnUmVtb3ZlUmVsYXRpb24nKSB7XG4gICAgICAgIGZvciAoY29uc3Qgb2JqZWN0IG9mIG9wLm9iamVjdHMpIHtcbiAgICAgICAgICBwZW5kaW5nLnB1c2goXG4gICAgICAgICAgICB0aGlzLnJlbW92ZVJlbGF0aW9uKGtleSwgY2xhc3NOYW1lLCBvYmplY3RJZCwgb2JqZWN0Lm9iamVjdElkKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBQcm9taXNlLmFsbChwZW5kaW5nKTtcbiAgfVxuXG4gIC8vIEFkZHMgYSByZWxhdGlvbi5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBhZGQgd2FzIHN1Y2Nlc3NmdWwuXG4gIGFkZFJlbGF0aW9uKFxuICAgIGtleTogc3RyaW5nLFxuICAgIGZyb21DbGFzc05hbWU6IHN0cmluZyxcbiAgICBmcm9tSWQ6IHN0cmluZyxcbiAgICB0b0lkOiBzdHJpbmdcbiAgKSB7XG4gICAgY29uc3QgZG9jID0ge1xuICAgICAgcmVsYXRlZElkOiB0b0lkLFxuICAgICAgb3duaW5nSWQ6IGZyb21JZCxcbiAgICB9O1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgYF9Kb2luOiR7a2V5fToke2Zyb21DbGFzc05hbWV9YCxcbiAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgZG9jLFxuICAgICAgZG9jXG4gICAgKTtcbiAgfVxuXG4gIC8vIFJlbW92ZXMgYSByZWxhdGlvbi5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSByZW1vdmUgd2FzXG4gIC8vIHN1Y2Nlc3NmdWwuXG4gIHJlbW92ZVJlbGF0aW9uKFxuICAgIGtleTogc3RyaW5nLFxuICAgIGZyb21DbGFzc05hbWU6IHN0cmluZyxcbiAgICBmcm9tSWQ6IHN0cmluZyxcbiAgICB0b0lkOiBzdHJpbmdcbiAgKSB7XG4gICAgdmFyIGRvYyA9IHtcbiAgICAgIHJlbGF0ZWRJZDogdG9JZCxcbiAgICAgIG93bmluZ0lkOiBmcm9tSWQsXG4gICAgfTtcbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuZGVsZXRlT2JqZWN0c0J5UXVlcnkoXG4gICAgICAgIGBfSm9pbjoke2tleX06JHtmcm9tQ2xhc3NOYW1lfWAsXG4gICAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgICBkb2NcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIC8vIFdlIGRvbid0IGNhcmUgaWYgdGhleSB0cnkgdG8gZGVsZXRlIGEgbm9uLWV4aXN0ZW50IHJlbGF0aW9uLlxuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gIH1cblxuICAvLyBSZW1vdmVzIG9iamVjdHMgbWF0Y2hlcyB0aGlzIHF1ZXJ5IGZyb20gdGhlIGRhdGFiYXNlLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSBpZmYgdGhlIG9iamVjdCB3YXNcbiAgLy8gZGVsZXRlZC5cbiAgLy8gT3B0aW9uczpcbiAgLy8gICBhY2w6ICBhIGxpc3Qgb2Ygc3RyaW5ncy4gSWYgdGhlIG9iamVjdCB0byBiZSB1cGRhdGVkIGhhcyBhbiBBQ0wsXG4gIC8vICAgICAgICAgb25lIG9mIHRoZSBwcm92aWRlZCBzdHJpbmdzIG11c3QgcHJvdmlkZSB0aGUgY2FsbGVyIHdpdGhcbiAgLy8gICAgICAgICB3cml0ZSBwZXJtaXNzaW9ucy5cbiAgZGVzdHJveShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIHsgYWNsIH06IFF1ZXJ5T3B0aW9ucyA9IHt9XG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY2xHcm91cCA9IGFjbCB8fCBbXTtcblxuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICA/IFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAgIDogc2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ2RlbGV0ZScpXG4gICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICBpZiAoIWlzTWFzdGVyKSB7XG4gICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAnZGVsZXRlJyxcbiAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgYWNsR3JvdXBcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQuJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gZGVsZXRlIGJ5IHF1ZXJ5XG4gICAgICAgIGlmIChhY2wpIHtcbiAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpO1xuICAgICAgICB9XG4gICAgICAgIHZhbGlkYXRlUXVlcnkocXVlcnkpO1xuICAgICAgICByZXR1cm4gc2NoZW1hQ29udHJvbGxlclxuICAgICAgICAgIC5nZXRPbmVTY2hlbWEoY2xhc3NOYW1lKVxuICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAvLyBJZiB0aGUgc2NoZW1hIGRvZXNuJ3QgZXhpc3QsIHByZXRlbmQgaXQgZXhpc3RzIHdpdGggbm8gZmllbGRzLiBUaGlzIGJlaGF2aW9yXG4gICAgICAgICAgICAvLyB3aWxsIGxpa2VseSBuZWVkIHJldmlzaXRpbmcuXG4gICAgICAgICAgICBpZiAoZXJyb3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICByZXR1cm4geyBmaWVsZHM6IHt9IH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHBhcnNlRm9ybWF0U2NoZW1hID0+XG4gICAgICAgICAgICB0aGlzLmFkYXB0ZXIuZGVsZXRlT2JqZWN0c0J5UXVlcnkoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgcGFyc2VGb3JtYXRTY2hlbWEsXG4gICAgICAgICAgICAgIHF1ZXJ5XG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAvLyBXaGVuIGRlbGV0aW5nIHNlc3Npb25zIHdoaWxlIGNoYW5naW5nIHBhc3N3b3JkcywgZG9uJ3QgdGhyb3cgYW4gZXJyb3IgaWYgdGhleSBkb24ndCBoYXZlIGFueSBzZXNzaW9ucy5cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgY2xhc3NOYW1lID09PSAnX1Nlc3Npb24nICYmXG4gICAgICAgICAgICAgIGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkRcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHt9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBJbnNlcnRzIGFuIG9iamVjdCBpbnRvIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBvYmplY3Qgc2F2ZWQuXG4gIGNyZWF0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3Q6IGFueSxcbiAgICB7IGFjbCB9OiBRdWVyeU9wdGlvbnMgPSB7fVxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIC8vIE1ha2UgYSBjb3B5IG9mIHRoZSBvYmplY3QsIHNvIHdlIGRvbid0IG11dGF0ZSB0aGUgaW5jb21pbmcgZGF0YS5cbiAgICBjb25zdCBvcmlnaW5hbE9iamVjdCA9IG9iamVjdDtcbiAgICBvYmplY3QgPSB0cmFuc2Zvcm1PYmplY3RBQ0wob2JqZWN0KTtcblxuICAgIG9iamVjdC5jcmVhdGVkQXQgPSB7IGlzbzogb2JqZWN0LmNyZWF0ZWRBdCwgX190eXBlOiAnRGF0ZScgfTtcbiAgICBvYmplY3QudXBkYXRlZEF0ID0geyBpc286IG9iamVjdC51cGRhdGVkQXQsIF9fdHlwZTogJ0RhdGUnIH07XG5cbiAgICB2YXIgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICB2YXIgYWNsR3JvdXAgPSBhY2wgfHwgW107XG4gICAgY29uc3QgcmVsYXRpb25VcGRhdGVzID0gdGhpcy5jb2xsZWN0UmVsYXRpb25VcGRhdGVzKFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgbnVsbCxcbiAgICAgIG9iamVjdFxuICAgICk7XG4gICAgcmV0dXJuIHRoaXMudmFsaWRhdGVDbGFzc05hbWUoY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5sb2FkU2NoZW1hKCkpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdjcmVhdGUnKVxuICAgICAgICApXG4gICAgICAgICAgLnRoZW4oKCkgPT4gc2NoZW1hQ29udHJvbGxlci5lbmZvcmNlQ2xhc3NFeGlzdHMoY2xhc3NOYW1lKSlcbiAgICAgICAgICAudGhlbigoKSA9PiBzY2hlbWFDb250cm9sbGVyLnJlbG9hZERhdGEoKSlcbiAgICAgICAgICAudGhlbigoKSA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpKVxuICAgICAgICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICAgICAgICB0cmFuc2Zvcm1BdXRoRGF0YShjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgICAgIGZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUob2JqZWN0KTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuY3JlYXRlT2JqZWN0KFxuICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgIFNjaGVtYUNvbnRyb2xsZXIuY29udmVydFNjaGVtYVRvQWRhcHRlclNjaGVtYShzY2hlbWEpLFxuICAgICAgICAgICAgICBvYmplY3RcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlUmVsYXRpb25VcGRhdGVzKFxuICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgIG9iamVjdC5vYmplY3RJZCxcbiAgICAgICAgICAgICAgb2JqZWN0LFxuICAgICAgICAgICAgICByZWxhdGlvblVwZGF0ZXNcbiAgICAgICAgICAgICkudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIHJldHVybiBzYW5pdGl6ZURhdGFiYXNlUmVzdWx0KG9yaWdpbmFsT2JqZWN0LCByZXN1bHQub3BzWzBdKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gIH1cblxuICBjYW5BZGRGaWVsZChcbiAgICBzY2hlbWE6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlcixcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3Q6IGFueSxcbiAgICBhY2xHcm91cDogc3RyaW5nW11cbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY2xhc3NTY2hlbWEgPSBzY2hlbWEuc2NoZW1hRGF0YVtjbGFzc05hbWVdO1xuICAgIGlmICghY2xhc3NTY2hlbWEpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmtleXMob2JqZWN0KTtcbiAgICBjb25zdCBzY2hlbWFGaWVsZHMgPSBPYmplY3Qua2V5cyhjbGFzc1NjaGVtYS5maWVsZHMpO1xuICAgIGNvbnN0IG5ld0tleXMgPSBmaWVsZHMuZmlsdGVyKGZpZWxkID0+IHtcbiAgICAgIC8vIFNraXAgZmllbGRzIHRoYXQgYXJlIHVuc2V0XG4gICAgICBpZiAoXG4gICAgICAgIG9iamVjdFtmaWVsZF0gJiZcbiAgICAgICAgb2JqZWN0W2ZpZWxkXS5fX29wICYmXG4gICAgICAgIG9iamVjdFtmaWVsZF0uX19vcCA9PT0gJ0RlbGV0ZSdcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2NoZW1hRmllbGRzLmluZGV4T2YoZmllbGQpIDwgMDtcbiAgICB9KTtcbiAgICBpZiAobmV3S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICByZXR1cm4gc2NoZW1hLnZhbGlkYXRlUGVybWlzc2lvbihjbGFzc05hbWUsIGFjbEdyb3VwLCAnYWRkRmllbGQnKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gV29uJ3QgZGVsZXRlIGNvbGxlY3Rpb25zIGluIHRoZSBzeXN0ZW0gbmFtZXNwYWNlXG4gIC8qKlxuICAgKiBEZWxldGUgYWxsIGNsYXNzZXMgYW5kIGNsZWFycyB0aGUgc2NoZW1hIGNhY2hlXG4gICAqXG4gICAqIEBwYXJhbSB7Ym9vbGVhbn0gZmFzdCBzZXQgdG8gdHJ1ZSBpZiBpdCdzIG9rIHRvIGp1c3QgZGVsZXRlIHJvd3MgYW5kIG5vdCBpbmRleGVzXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fSB3aGVuIHRoZSBkZWxldGlvbnMgY29tcGxldGVzXG4gICAqL1xuICBkZWxldGVFdmVyeXRoaW5nKGZhc3Q6IGJvb2xlYW4gPSBmYWxzZSk6IFByb21pc2U8YW55PiB7XG4gICAgdGhpcy5zY2hlbWFQcm9taXNlID0gbnVsbDtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgdGhpcy5hZGFwdGVyLmRlbGV0ZUFsbENsYXNzZXMoZmFzdCksXG4gICAgICB0aGlzLnNjaGVtYUNhY2hlLmNsZWFyKCksXG4gICAgXSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSBsaXN0IG9mIHJlbGF0ZWQgaWRzIGdpdmVuIGFuIG93bmluZyBpZC5cbiAgLy8gY2xhc3NOYW1lIGhlcmUgaXMgdGhlIG93bmluZyBjbGFzc05hbWUuXG4gIHJlbGF0ZWRJZHMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAga2V5OiBzdHJpbmcsXG4gICAgb3duaW5nSWQ6IHN0cmluZyxcbiAgICBxdWVyeU9wdGlvbnM6IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPEFycmF5PHN0cmluZz4+IHtcbiAgICBjb25zdCB7IHNraXAsIGxpbWl0LCBzb3J0IH0gPSBxdWVyeU9wdGlvbnM7XG4gICAgY29uc3QgZmluZE9wdGlvbnMgPSB7fTtcbiAgICBpZiAoc29ydCAmJiBzb3J0LmNyZWF0ZWRBdCAmJiB0aGlzLmFkYXB0ZXIuY2FuU29ydE9uSm9pblRhYmxlcykge1xuICAgICAgZmluZE9wdGlvbnMuc29ydCA9IHsgX2lkOiBzb3J0LmNyZWF0ZWRBdCB9O1xuICAgICAgZmluZE9wdGlvbnMubGltaXQgPSBsaW1pdDtcbiAgICAgIGZpbmRPcHRpb25zLnNraXAgPSBza2lwO1xuICAgICAgcXVlcnlPcHRpb25zLnNraXAgPSAwO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuZmluZChcbiAgICAgICAgam9pblRhYmxlTmFtZShjbGFzc05hbWUsIGtleSksXG4gICAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgICB7IG93bmluZ0lkIH0sXG4gICAgICAgIGZpbmRPcHRpb25zXG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHJlc3VsdHMubWFwKHJlc3VsdCA9PiByZXN1bHQucmVsYXRlZElkKSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSBsaXN0IG9mIG93bmluZyBpZHMgZ2l2ZW4gc29tZSByZWxhdGVkIGlkcy5cbiAgLy8gY2xhc3NOYW1lIGhlcmUgaXMgdGhlIG93bmluZyBjbGFzc05hbWUuXG4gIG93bmluZ0lkcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBrZXk6IHN0cmluZyxcbiAgICByZWxhdGVkSWRzOiBzdHJpbmdbXVxuICApOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgLmZpbmQoXG4gICAgICAgIGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBrZXkpLFxuICAgICAgICByZWxhdGlvblNjaGVtYSxcbiAgICAgICAgeyByZWxhdGVkSWQ6IHsgJGluOiByZWxhdGVkSWRzIH0gfSxcbiAgICAgICAge31cbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4gcmVzdWx0cy5tYXAocmVzdWx0ID0+IHJlc3VsdC5vd25pbmdJZCkpO1xuICB9XG5cbiAgLy8gTW9kaWZpZXMgcXVlcnkgc28gdGhhdCBpdCBubyBsb25nZXIgaGFzICRpbiBvbiByZWxhdGlvbiBmaWVsZHMsIG9yXG4gIC8vIGVxdWFsLXRvLXBvaW50ZXIgY29uc3RyYWludHMgb24gcmVsYXRpb24gZmllbGRzLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gcXVlcnkgaXMgbXV0YXRlZFxuICByZWR1Y2VJblJlbGF0aW9uKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogYW55LCBzY2hlbWE6IGFueSk6IFByb21pc2U8YW55PiB7XG4gICAgLy8gU2VhcmNoIGZvciBhbiBpbi1yZWxhdGlvbiBvciBlcXVhbC10by1yZWxhdGlvblxuICAgIC8vIE1ha2UgaXQgc2VxdWVudGlhbCBmb3Igbm93LCBub3Qgc3VyZSBvZiBwYXJhbGxlaXphdGlvbiBzaWRlIGVmZmVjdHNcbiAgICBpZiAocXVlcnlbJyRvciddKSB7XG4gICAgICBjb25zdCBvcnMgPSBxdWVyeVsnJG9yJ107XG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIG9ycy5tYXAoKGFRdWVyeSwgaW5kZXgpID0+IHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5yZWR1Y2VJblJlbGF0aW9uKGNsYXNzTmFtZSwgYVF1ZXJ5LCBzY2hlbWEpLnRoZW4oXG4gICAgICAgICAgICBhUXVlcnkgPT4ge1xuICAgICAgICAgICAgICBxdWVyeVsnJG9yJ11baW5kZXhdID0gYVF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICk7XG4gICAgICAgIH0pXG4gICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHByb21pc2VzID0gT2JqZWN0LmtleXMocXVlcnkpLm1hcChrZXkgPT4ge1xuICAgICAgY29uc3QgdCA9IHNjaGVtYS5nZXRFeHBlY3RlZFR5cGUoY2xhc3NOYW1lLCBrZXkpO1xuICAgICAgaWYgKCF0IHx8IHQudHlwZSAhPT0gJ1JlbGF0aW9uJykge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIGxldCBxdWVyaWVzOiA/KGFueVtdKSA9IG51bGw7XG4gICAgICBpZiAoXG4gICAgICAgIHF1ZXJ5W2tleV0gJiZcbiAgICAgICAgKHF1ZXJ5W2tleV1bJyRpbiddIHx8XG4gICAgICAgICAgcXVlcnlba2V5XVsnJG5lJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldWyckbmluJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldLl9fdHlwZSA9PSAnUG9pbnRlcicpXG4gICAgICApIHtcbiAgICAgICAgLy8gQnVpbGQgdGhlIGxpc3Qgb2YgcXVlcmllc1xuICAgICAgICBxdWVyaWVzID0gT2JqZWN0LmtleXMocXVlcnlba2V5XSkubWFwKGNvbnN0cmFpbnRLZXkgPT4ge1xuICAgICAgICAgIGxldCByZWxhdGVkSWRzO1xuICAgICAgICAgIGxldCBpc05lZ2F0aW9uID0gZmFsc2U7XG4gICAgICAgICAgaWYgKGNvbnN0cmFpbnRLZXkgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMgPSBbcXVlcnlba2V5XS5vYmplY3RJZF07XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckaW4nKSB7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJGluJ10ubWFwKHIgPT4gci5vYmplY3RJZCk7XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckbmluJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJG5pbiddLm1hcChyID0+IHIub2JqZWN0SWQpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoY29uc3RyYWludEtleSA9PSAnJG5lJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gW3F1ZXJ5W2tleV1bJyRuZSddLm9iamVjdElkXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgaXNOZWdhdGlvbixcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWVyaWVzID0gW3sgaXNOZWdhdGlvbjogZmFsc2UsIHJlbGF0ZWRJZHM6IFtdIH1dO1xuICAgICAgfVxuXG4gICAgICAvLyByZW1vdmUgdGhlIGN1cnJlbnQgcXVlcnlLZXkgYXMgd2UgZG9uLHQgbmVlZCBpdCBhbnltb3JlXG4gICAgICBkZWxldGUgcXVlcnlba2V5XTtcbiAgICAgIC8vIGV4ZWN1dGUgZWFjaCBxdWVyeSBpbmRlcGVuZGVudGx5IHRvIGJ1aWxkIHRoZSBsaXN0IG9mXG4gICAgICAvLyAkaW4gLyAkbmluXG4gICAgICBjb25zdCBwcm9taXNlcyA9IHF1ZXJpZXMubWFwKHEgPT4ge1xuICAgICAgICBpZiAoIXEpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXMub3duaW5nSWRzKGNsYXNzTmFtZSwga2V5LCBxLnJlbGF0ZWRJZHMpLnRoZW4oaWRzID0+IHtcbiAgICAgICAgICBpZiAocS5pc05lZ2F0aW9uKSB7XG4gICAgICAgICAgICB0aGlzLmFkZE5vdEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmFkZEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcykudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKS50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocXVlcnkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gTW9kaWZpZXMgcXVlcnkgc28gdGhhdCBpdCBubyBsb25nZXIgaGFzICRyZWxhdGVkVG9cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHF1ZXJ5IGlzIG11dGF0ZWRcbiAgcmVkdWNlUmVsYXRpb25LZXlzKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHF1ZXJ5OiBhbnksXG4gICAgcXVlcnlPcHRpb25zOiBhbnlcbiAgKTogP1Byb21pc2U8dm9pZD4ge1xuICAgIGlmIChxdWVyeVsnJG9yJ10pIHtcbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgcXVlcnlbJyRvciddLm1hcChhUXVlcnkgPT4ge1xuICAgICAgICAgIHJldHVybiB0aGlzLnJlZHVjZVJlbGF0aW9uS2V5cyhjbGFzc05hbWUsIGFRdWVyeSwgcXVlcnlPcHRpb25zKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdmFyIHJlbGF0ZWRUbyA9IHF1ZXJ5WyckcmVsYXRlZFRvJ107XG4gICAgaWYgKHJlbGF0ZWRUbykge1xuICAgICAgcmV0dXJuIHRoaXMucmVsYXRlZElkcyhcbiAgICAgICAgcmVsYXRlZFRvLm9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgIHJlbGF0ZWRUby5rZXksXG4gICAgICAgIHJlbGF0ZWRUby5vYmplY3Qub2JqZWN0SWQsXG4gICAgICAgIHF1ZXJ5T3B0aW9uc1xuICAgICAgKVxuICAgICAgICAudGhlbihpZHMgPT4ge1xuICAgICAgICAgIGRlbGV0ZSBxdWVyeVsnJHJlbGF0ZWRUbyddO1xuICAgICAgICAgIHRoaXMuYWRkSW5PYmplY3RJZHNJZHMoaWRzLCBxdWVyeSk7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKGNsYXNzTmFtZSwgcXVlcnksIHF1ZXJ5T3B0aW9ucyk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHt9KTtcbiAgICB9XG4gIH1cblxuICBhZGRJbk9iamVjdElkc0lkcyhpZHM6ID9BcnJheTxzdHJpbmc+ID0gbnVsbCwgcXVlcnk6IGFueSkge1xuICAgIGNvbnN0IGlkc0Zyb21TdHJpbmc6ID9BcnJheTxzdHJpbmc+ID1cbiAgICAgIHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZycgPyBbcXVlcnkub2JqZWN0SWRdIDogbnVsbDtcbiAgICBjb25zdCBpZHNGcm9tRXE6ID9BcnJheTxzdHJpbmc+ID1cbiAgICAgIHF1ZXJ5Lm9iamVjdElkICYmIHF1ZXJ5Lm9iamVjdElkWyckZXEnXSA/IFtxdWVyeS5vYmplY3RJZFsnJGVxJ11dIDogbnVsbDtcbiAgICBjb25zdCBpZHNGcm9tSW46ID9BcnJheTxzdHJpbmc+ID1cbiAgICAgIHF1ZXJ5Lm9iamVjdElkICYmIHF1ZXJ5Lm9iamVjdElkWyckaW4nXSA/IHF1ZXJ5Lm9iamVjdElkWyckaW4nXSA6IG51bGw7XG5cbiAgICAvLyBAZmxvdy1kaXNhYmxlLW5leHRcbiAgICBjb25zdCBhbGxJZHM6IEFycmF5PEFycmF5PHN0cmluZz4+ID0gW1xuICAgICAgaWRzRnJvbVN0cmluZyxcbiAgICAgIGlkc0Zyb21FcSxcbiAgICAgIGlkc0Zyb21JbixcbiAgICAgIGlkcyxcbiAgICBdLmZpbHRlcihsaXN0ID0+IGxpc3QgIT09IG51bGwpO1xuICAgIGNvbnN0IHRvdGFsTGVuZ3RoID0gYWxsSWRzLnJlZHVjZSgobWVtbywgbGlzdCkgPT4gbWVtbyArIGxpc3QubGVuZ3RoLCAwKTtcblxuICAgIGxldCBpZHNJbnRlcnNlY3Rpb24gPSBbXTtcbiAgICBpZiAodG90YWxMZW5ndGggPiAxMjUpIHtcbiAgICAgIGlkc0ludGVyc2VjdGlvbiA9IGludGVyc2VjdC5iaWcoYWxsSWRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWRzSW50ZXJzZWN0aW9uID0gaW50ZXJzZWN0KGFsbElkcyk7XG4gICAgfVxuXG4gICAgLy8gTmVlZCB0byBtYWtlIHN1cmUgd2UgZG9uJ3QgY2xvYmJlciBleGlzdGluZyBzaG9ydGhhbmQgJGVxIGNvbnN0cmFpbnRzIG9uIG9iamVjdElkLlxuICAgIGlmICghKCdvYmplY3RJZCcgaW4gcXVlcnkpKSB7XG4gICAgICBxdWVyeS5vYmplY3RJZCA9IHtcbiAgICAgICAgJGluOiB1bmRlZmluZWQsXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnkub2JqZWN0SWQgPSB7XG4gICAgICAgICRpbjogdW5kZWZpbmVkLFxuICAgICAgICAkZXE6IHF1ZXJ5Lm9iamVjdElkLFxuICAgICAgfTtcbiAgICB9XG4gICAgcXVlcnkub2JqZWN0SWRbJyRpbiddID0gaWRzSW50ZXJzZWN0aW9uO1xuXG4gICAgcmV0dXJuIHF1ZXJ5O1xuICB9XG5cbiAgYWRkTm90SW5PYmplY3RJZHNJZHMoaWRzOiBzdHJpbmdbXSA9IFtdLCBxdWVyeTogYW55KSB7XG4gICAgY29uc3QgaWRzRnJvbU5pbiA9XG4gICAgICBxdWVyeS5vYmplY3RJZCAmJiBxdWVyeS5vYmplY3RJZFsnJG5pbiddID8gcXVlcnkub2JqZWN0SWRbJyRuaW4nXSA6IFtdO1xuICAgIGxldCBhbGxJZHMgPSBbLi4uaWRzRnJvbU5pbiwgLi4uaWRzXS5maWx0ZXIobGlzdCA9PiBsaXN0ICE9PSBudWxsKTtcblxuICAgIC8vIG1ha2UgYSBzZXQgYW5kIHNwcmVhZCB0byByZW1vdmUgZHVwbGljYXRlc1xuICAgIGFsbElkcyA9IFsuLi5uZXcgU2V0KGFsbElkcyldO1xuXG4gICAgLy8gTmVlZCB0byBtYWtlIHN1cmUgd2UgZG9uJ3QgY2xvYmJlciBleGlzdGluZyBzaG9ydGhhbmQgJGVxIGNvbnN0cmFpbnRzIG9uIG9iamVjdElkLlxuICAgIGlmICghKCdvYmplY3RJZCcgaW4gcXVlcnkpKSB7XG4gICAgICBxdWVyeS5vYmplY3RJZCA9IHtcbiAgICAgICAgJG5pbjogdW5kZWZpbmVkLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0ge1xuICAgICAgICAkbmluOiB1bmRlZmluZWQsXG4gICAgICAgICRlcTogcXVlcnkub2JqZWN0SWQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHF1ZXJ5Lm9iamVjdElkWyckbmluJ10gPSBhbGxJZHM7XG4gICAgcmV0dXJuIHF1ZXJ5O1xuICB9XG5cbiAgLy8gUnVucyBhIHF1ZXJ5IG9uIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhIGxpc3Qgb2YgaXRlbXMuXG4gIC8vIE9wdGlvbnM6XG4gIC8vICAgc2tpcCAgICBudW1iZXIgb2YgcmVzdWx0cyB0byBza2lwLlxuICAvLyAgIGxpbWl0ICAgbGltaXQgdG8gdGhpcyBudW1iZXIgb2YgcmVzdWx0cy5cbiAgLy8gICBzb3J0ICAgIGFuIG9iamVjdCB3aGVyZSBrZXlzIGFyZSB0aGUgZmllbGRzIHRvIHNvcnQgYnkuXG4gIC8vICAgICAgICAgICB0aGUgdmFsdWUgaXMgKzEgZm9yIGFzY2VuZGluZywgLTEgZm9yIGRlc2NlbmRpbmcuXG4gIC8vICAgY291bnQgICBydW4gYSBjb3VudCBpbnN0ZWFkIG9mIHJldHVybmluZyByZXN1bHRzLlxuICAvLyAgIGFjbCAgICAgcmVzdHJpY3QgdGhpcyBvcGVyYXRpb24gd2l0aCBhbiBBQ0wgZm9yIHRoZSBwcm92aWRlZCBhcnJheVxuICAvLyAgICAgICAgICAgb2YgdXNlciBvYmplY3RJZHMgYW5kIHJvbGVzLiBhY2w6IG51bGwgbWVhbnMgbm8gdXNlci5cbiAgLy8gICAgICAgICAgIHdoZW4gdGhpcyBmaWVsZCBpcyBub3QgcHJlc2VudCwgZG9uJ3QgZG8gYW55dGhpbmcgcmVnYXJkaW5nIEFDTHMuXG4gIC8vIFRPRE86IG1ha2UgdXNlcklkcyBub3QgbmVlZGVkIGhlcmUuIFRoZSBkYiBhZGFwdGVyIHNob3VsZG4ndCBrbm93XG4gIC8vIGFueXRoaW5nIGFib3V0IHVzZXJzLCBpZGVhbGx5LiBUaGVuLCBpbXByb3ZlIHRoZSBmb3JtYXQgb2YgdGhlIEFDTFxuICAvLyBhcmcgdG8gd29yayBsaWtlIHRoZSBvdGhlcnMuXG4gIGZpbmQoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBhY2wsXG4gICAgICBzb3J0ID0ge30sXG4gICAgICBjb3VudCxcbiAgICAgIGtleXMsXG4gICAgICBvcCxcbiAgICAgIGRpc3RpbmN0LFxuICAgICAgcGlwZWxpbmUsXG4gICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICB9OiBhbnkgPSB7fVxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgYWNsR3JvdXAgPSBhY2wgfHwgW107XG4gICAgb3AgPVxuICAgICAgb3AgfHxcbiAgICAgICh0eXBlb2YgcXVlcnkub2JqZWN0SWQgPT0gJ3N0cmluZycgJiYgT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCA9PT0gMVxuICAgICAgICA/ICdnZXQnXG4gICAgICAgIDogJ2ZpbmQnKTtcbiAgICAvLyBDb3VudCBvcGVyYXRpb24gaWYgY291bnRpbmdcbiAgICBvcCA9IGNvdW50ID09PSB0cnVlID8gJ2NvdW50JyA6IG9wO1xuXG4gICAgbGV0IGNsYXNzRXhpc3RzID0gdHJ1ZTtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgIC8vQWxsb3cgdm9sYXRpbGUgY2xhc3NlcyBpZiBxdWVyeWluZyB3aXRoIE1hc3RlciAoZm9yIF9QdXNoU3RhdHVzKVxuICAgICAgLy9UT0RPOiBNb3ZlIHZvbGF0aWxlIGNsYXNzZXMgY29uY2VwdCBpbnRvIG1vbmdvIGFkYXB0ZXIsIHBvc3RncmVzIGFkYXB0ZXIgc2hvdWxkbid0IGNhcmVcbiAgICAgIC8vdGhhdCBhcGkucGFyc2UuY29tIGJyZWFrcyB3aGVuIF9QdXNoU3RhdHVzIGV4aXN0cyBpbiBtb25nby5cbiAgICAgIHJldHVybiBzY2hlbWFDb250cm9sbGVyXG4gICAgICAgIC5nZXRPbmVTY2hlbWEoY2xhc3NOYW1lLCBpc01hc3RlcilcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAvLyBCZWhhdmlvciBmb3Igbm9uLWV4aXN0ZW50IGNsYXNzZXMgaXMga2luZGEgd2VpcmQgb24gUGFyc2UuY29tLiBQcm9iYWJseSBkb2Vzbid0IG1hdHRlciB0b28gbXVjaC5cbiAgICAgICAgICAvLyBGb3Igbm93LCBwcmV0ZW5kIHRoZSBjbGFzcyBleGlzdHMgYnV0IGhhcyBubyBvYmplY3RzLFxuICAgICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBjbGFzc0V4aXN0cyA9IGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuIHsgZmllbGRzOiB7fSB9O1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgICAgICAvLyBQYXJzZS5jb20gdHJlYXRzIHF1ZXJpZXMgb24gX2NyZWF0ZWRfYXQgYW5kIF91cGRhdGVkX2F0IGFzIGlmIHRoZXkgd2VyZSBxdWVyaWVzIG9uIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0LFxuICAgICAgICAgIC8vIHNvIGR1cGxpY2F0ZSB0aGF0IGJlaGF2aW9yIGhlcmUuIElmIGJvdGggYXJlIHNwZWNpZmllZCwgdGhlIGNvcnJlY3QgYmVoYXZpb3IgdG8gbWF0Y2ggUGFyc2UuY29tIGlzIHRvXG4gICAgICAgICAgLy8gdXNlIHRoZSBvbmUgdGhhdCBhcHBlYXJzIGZpcnN0IGluIHRoZSBzb3J0IGxpc3QuXG4gICAgICAgICAgaWYgKHNvcnQuX2NyZWF0ZWRfYXQpIHtcbiAgICAgICAgICAgIHNvcnQuY3JlYXRlZEF0ID0gc29ydC5fY3JlYXRlZF9hdDtcbiAgICAgICAgICAgIGRlbGV0ZSBzb3J0Ll9jcmVhdGVkX2F0O1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoc29ydC5fdXBkYXRlZF9hdCkge1xuICAgICAgICAgICAgc29ydC51cGRhdGVkQXQgPSBzb3J0Ll91cGRhdGVkX2F0O1xuICAgICAgICAgICAgZGVsZXRlIHNvcnQuX3VwZGF0ZWRfYXQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IHsgc2tpcCwgbGltaXQsIHNvcnQsIGtleXMsIHJlYWRQcmVmZXJlbmNlIH07XG4gICAgICAgICAgT2JqZWN0LmtleXMoc29ydCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5tYXRjaCgvXmF1dGhEYXRhXFwuKFthLXpBLVowLTlfXSspXFwuaWQkLykpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICAgICAgYENhbm5vdCBzb3J0IGJ5ICR7ZmllbGROYW1lfWBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHJvb3RGaWVsZE5hbWUgPSBnZXRSb290RmllbGROYW1lKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICBpZiAoIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lKSkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICAgICAgICAgICBgSW52YWxpZCBmaWVsZCBuYW1lOiAke2ZpZWxkTmFtZX0uYFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybiAoaXNNYXN0ZXJcbiAgICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICAgIDogc2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgb3ApXG4gICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5yZWR1Y2VSZWxhdGlvbktleXMoY2xhc3NOYW1lLCBxdWVyeSwgcXVlcnlPcHRpb25zKSlcbiAgICAgICAgICAgIC50aGVuKCgpID0+XG4gICAgICAgICAgICAgIHRoaXMucmVkdWNlSW5SZWxhdGlvbihjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWFDb250cm9sbGVyKVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICBpZiAoIWlzTWFzdGVyKSB7XG4gICAgICAgICAgICAgICAgcXVlcnkgPSB0aGlzLmFkZFBvaW50ZXJQZXJtaXNzaW9ucyhcbiAgICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgYWNsR3JvdXBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgICAgICBpZiAob3AgPT09ICdnZXQnKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgICAgIGlmIChvcCA9PT0gJ3VwZGF0ZScgfHwgb3AgPT09ICdkZWxldGUnKSB7XG4gICAgICAgICAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2xHcm91cCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5ID0gYWRkUmVhZEFDTChxdWVyeSwgYWNsR3JvdXApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB2YWxpZGF0ZVF1ZXJ5KHF1ZXJ5KTtcbiAgICAgICAgICAgICAgaWYgKGNvdW50KSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIDA7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuY291bnQoXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2UgaWYgKGRpc3RpbmN0KSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmRpc3RpbmN0KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIGRpc3RpbmN0XG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBlbHNlIGlmIChwaXBlbGluZSkge1xuICAgICAgICAgICAgICAgIGlmICghY2xhc3NFeGlzdHMpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5hZ2dyZWdhdGUoXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICBwaXBlbGluZSxcbiAgICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgICAgICAgICAgICAgIC5maW5kKGNsYXNzTmFtZSwgc2NoZW1hLCBxdWVyeSwgcXVlcnlPcHRpb25zKVxuICAgICAgICAgICAgICAgICAgLnRoZW4ob2JqZWN0cyA9PlxuICAgICAgICAgICAgICAgICAgICBvYmplY3RzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIG9iamVjdCA9IHVudHJhbnNmb3JtT2JqZWN0QUNMKG9iamVjdCk7XG4gICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZpbHRlclNlbnNpdGl2ZURhdGEoXG4gICAgICAgICAgICAgICAgICAgICAgICBpc01hc3RlcixcbiAgICAgICAgICAgICAgICAgICAgICAgIGFjbEdyb3VwLFxuICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0XG4gICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAgICAgICAgICAgICAgICAgZXJyb3JcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBkZWxldGVTY2hlbWEoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKHsgY2xlYXJDYWNoZTogdHJ1ZSB9KVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXR1cm4geyBmaWVsZHM6IHt9IH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAudGhlbigoc2NoZW1hOiBhbnkpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuY29sbGVjdGlvbkV4aXN0cyhjbGFzc05hbWUpXG4gICAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5hZGFwdGVyLmNvdW50KGNsYXNzTmFtZSwgeyBmaWVsZHM6IHt9IH0pKVxuICAgICAgICAgIC50aGVuKGNvdW50ID0+IHtcbiAgICAgICAgICAgIGlmIChjb3VudCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIDI1NSxcbiAgICAgICAgICAgICAgICBgQ2xhc3MgJHtjbGFzc05hbWV9IGlzIG5vdCBlbXB0eSwgY29udGFpbnMgJHtjb3VudH0gb2JqZWN0cywgY2Fubm90IGRyb3Agc2NoZW1hLmBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZGVsZXRlQ2xhc3MoY2xhc3NOYW1lKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHdhc1BhcnNlQ29sbGVjdGlvbiA9PiB7XG4gICAgICAgICAgICBpZiAod2FzUGFyc2VDb2xsZWN0aW9uKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlbGF0aW9uRmllbGROYW1lcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZpbHRlcihcbiAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPT4gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdSZWxhdGlvbidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICAgICAgICAgIHJlbGF0aW9uRmllbGROYW1lcy5tYXAobmFtZSA9PlxuICAgICAgICAgICAgICAgICAgdGhpcy5hZGFwdGVyLmRlbGV0ZUNsYXNzKGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBuYW1lKSlcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICkudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICB9XG5cbiAgYWRkUG9pbnRlclBlcm1pc3Npb25zKFxuICAgIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9wZXJhdGlvbjogc3RyaW5nLFxuICAgIHF1ZXJ5OiBhbnksXG4gICAgYWNsR3JvdXA6IGFueVtdID0gW11cbiAgKSB7XG4gICAgLy8gQ2hlY2sgaWYgY2xhc3MgaGFzIHB1YmxpYyBwZXJtaXNzaW9uIGZvciBvcGVyYXRpb25cbiAgICAvLyBJZiB0aGUgQmFzZUNMUCBwYXNzLCBsZXQgZ28gdGhyb3VnaFxuICAgIGlmIChzY2hlbWEudGVzdFBlcm1pc3Npb25zRm9yQ2xhc3NOYW1lKGNsYXNzTmFtZSwgYWNsR3JvdXAsIG9wZXJhdGlvbikpIHtcbiAgICAgIHJldHVybiBxdWVyeTtcbiAgICB9XG4gICAgY29uc3QgcGVybXMgPSBzY2hlbWEuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZSk7XG4gICAgY29uc3QgZmllbGQgPVxuICAgICAgWydnZXQnLCAnZmluZCddLmluZGV4T2Yob3BlcmF0aW9uKSA+IC0xXG4gICAgICAgID8gJ3JlYWRVc2VyRmllbGRzJ1xuICAgICAgICA6ICd3cml0ZVVzZXJGaWVsZHMnO1xuICAgIGNvbnN0IHVzZXJBQ0wgPSBhY2xHcm91cC5maWx0ZXIoYWNsID0+IHtcbiAgICAgIHJldHVybiBhY2wuaW5kZXhPZigncm9sZTonKSAhPSAwICYmIGFjbCAhPSAnKic7XG4gICAgfSk7XG4gICAgLy8gdGhlIEFDTCBzaG91bGQgaGF2ZSBleGFjdGx5IDEgdXNlclxuICAgIGlmIChwZXJtcyAmJiBwZXJtc1tmaWVsZF0gJiYgcGVybXNbZmllbGRdLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIE5vIHVzZXIgc2V0IHJldHVybiB1bmRlZmluZWRcbiAgICAgIC8vIElmIHRoZSBsZW5ndGggaXMgPiAxLCB0aGF0IG1lYW5zIHdlIGRpZG4ndCBkZS1kdXBlIHVzZXJzIGNvcnJlY3RseVxuICAgICAgaWYgKHVzZXJBQ0wubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3QgdXNlcklkID0gdXNlckFDTFswXTtcbiAgICAgIGNvbnN0IHVzZXJQb2ludGVyID0ge1xuICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICBvYmplY3RJZDogdXNlcklkLFxuICAgICAgfTtcblxuICAgICAgY29uc3QgcGVybUZpZWxkcyA9IHBlcm1zW2ZpZWxkXTtcbiAgICAgIGNvbnN0IG9ycyA9IHBlcm1GaWVsZHMubWFwKGtleSA9PiB7XG4gICAgICAgIGNvbnN0IHEgPSB7XG4gICAgICAgICAgW2tleV06IHVzZXJQb2ludGVyLFxuICAgICAgICB9O1xuICAgICAgICAvLyBpZiB3ZSBhbHJlYWR5IGhhdmUgYSBjb25zdHJhaW50IG9uIHRoZSBrZXksIHVzZSB0aGUgJGFuZFxuICAgICAgICBpZiAocXVlcnkuaGFzT3duUHJvcGVydHkoa2V5KSkge1xuICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFtxLCBxdWVyeV0gfTtcbiAgICAgICAgfVxuICAgICAgICAvLyBvdGhlcndpc2UganVzdCBhZGQgdGhlIGNvbnN0YWludFxuICAgICAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgcXVlcnksIHtcbiAgICAgICAgICBbYCR7a2V5fWBdOiB1c2VyUG9pbnRlcixcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICAgIGlmIChvcnMubGVuZ3RoID4gMSkge1xuICAgICAgICByZXR1cm4geyAkb3I6IG9ycyB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIG9yc1swXTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHF1ZXJ5O1xuICAgIH1cbiAgfVxuXG4gIC8vIFRPRE86IGNyZWF0ZSBpbmRleGVzIG9uIGZpcnN0IGNyZWF0aW9uIG9mIGEgX1VzZXIgb2JqZWN0LiBPdGhlcndpc2UgaXQncyBpbXBvc3NpYmxlIHRvXG4gIC8vIGhhdmUgYSBQYXJzZSBhcHAgd2l0aG91dCBpdCBoYXZpbmcgYSBfVXNlciBjb2xsZWN0aW9uLlxuICBwZXJmb3JtSW5pdGlhbGl6YXRpb24oKSB7XG4gICAgY29uc3QgcmVxdWlyZWRVc2VyRmllbGRzID0ge1xuICAgICAgZmllbGRzOiB7XG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX0RlZmF1bHQsXG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX1VzZXIsXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVxdWlyZWRSb2xlRmllbGRzID0ge1xuICAgICAgZmllbGRzOiB7XG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX0RlZmF1bHQsXG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX1JvbGUsXG4gICAgICB9LFxuICAgIH07XG5cbiAgICBjb25zdCB1c2VyQ2xhc3NQcm9taXNlID0gdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT5cbiAgICAgIHNjaGVtYS5lbmZvcmNlQ2xhc3NFeGlzdHMoJ19Vc2VyJylcbiAgICApO1xuICAgIGNvbnN0IHJvbGVDbGFzc1Byb21pc2UgPSB0aGlzLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYSA9PlxuICAgICAgc2NoZW1hLmVuZm9yY2VDbGFzc0V4aXN0cygnX1JvbGUnKVxuICAgICk7XG5cbiAgICBjb25zdCB1c2VybmFtZVVuaXF1ZW5lc3MgPSB1c2VyQ2xhc3NQcm9taXNlXG4gICAgICAudGhlbigoKSA9PlxuICAgICAgICB0aGlzLmFkYXB0ZXIuZW5zdXJlVW5pcXVlbmVzcygnX1VzZXInLCByZXF1aXJlZFVzZXJGaWVsZHMsIFsndXNlcm5hbWUnXSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIHVzZXJuYW1lczogJywgZXJyb3IpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZW1haWxVbmlxdWVuZXNzID0gdXNlckNsYXNzUHJvbWlzZVxuICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgdGhpcy5hZGFwdGVyLmVuc3VyZVVuaXF1ZW5lc3MoJ19Vc2VyJywgcmVxdWlyZWRVc2VyRmllbGRzLCBbJ2VtYWlsJ10pXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBsb2dnZXIud2FybihcbiAgICAgICAgICAnVW5hYmxlIHRvIGVuc3VyZSB1bmlxdWVuZXNzIGZvciB1c2VyIGVtYWlsIGFkZHJlc3NlczogJyxcbiAgICAgICAgICBlcnJvclxuICAgICAgICApO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuXG4gICAgY29uc3Qgcm9sZVVuaXF1ZW5lc3MgPSByb2xlQ2xhc3NQcm9taXNlXG4gICAgICAudGhlbigoKSA9PlxuICAgICAgICB0aGlzLmFkYXB0ZXIuZW5zdXJlVW5pcXVlbmVzcygnX1JvbGUnLCByZXF1aXJlZFJvbGVGaWVsZHMsIFsnbmFtZSddKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBlbnN1cmUgdW5pcXVlbmVzcyBmb3Igcm9sZSBuYW1lOiAnLCBlcnJvcik7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG5cbiAgICBjb25zdCBpbmRleFByb21pc2UgPSB0aGlzLmFkYXB0ZXIudXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMoKTtcblxuICAgIC8vIENyZWF0ZSB0YWJsZXMgZm9yIHZvbGF0aWxlIGNsYXNzZXNcbiAgICBjb25zdCBhZGFwdGVySW5pdCA9IHRoaXMuYWRhcHRlci5wZXJmb3JtSW5pdGlhbGl6YXRpb24oe1xuICAgICAgVm9sYXRpbGVDbGFzc2VzU2NoZW1hczogU2NoZW1hQ29udHJvbGxlci5Wb2xhdGlsZUNsYXNzZXNTY2hlbWFzLFxuICAgIH0pO1xuICAgIHJldHVybiBQcm9taXNlLmFsbChbXG4gICAgICB1c2VybmFtZVVuaXF1ZW5lc3MsXG4gICAgICBlbWFpbFVuaXF1ZW5lc3MsXG4gICAgICByb2xlVW5pcXVlbmVzcyxcbiAgICAgIGFkYXB0ZXJJbml0LFxuICAgICAgaW5kZXhQcm9taXNlLFxuICAgIF0pO1xuICB9XG5cbiAgc3RhdGljIF92YWxpZGF0ZVF1ZXJ5OiBhbnkgPT4gdm9pZDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBEYXRhYmFzZUNvbnRyb2xsZXI7XG4vLyBFeHBvc2UgdmFsaWRhdGVRdWVyeSBmb3IgdGVzdHNcbm1vZHVsZS5leHBvcnRzLl92YWxpZGF0ZVF1ZXJ5ID0gdmFsaWRhdGVRdWVyeTtcbiJdfQ==