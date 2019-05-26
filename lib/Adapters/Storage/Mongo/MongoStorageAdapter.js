"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.MongoStorageAdapter = void 0;

var _MongoCollection = _interopRequireDefault(require("./MongoCollection"));

var _MongoSchemaCollection = _interopRequireDefault(require("./MongoSchemaCollection"));

var _StorageAdapter = require("../StorageAdapter");

var _mongodbUrl = require("../../../vendor/mongodbUrl");

var _MongoTransform = require("./MongoTransform");

var _node = _interopRequireDefault(require("parse/node"));

var _lodash = _interopRequireDefault(require("lodash"));

var _defaults = _interopRequireDefault(require("../../../defaults"));

var _logger = _interopRequireDefault(require("../../../logger"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _extends() { _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; }; return _extends.apply(this, arguments); }

// -disable-next
const mongodb = require('mongodb');

const MongoClient = mongodb.MongoClient;
const ReadPreference = mongodb.ReadPreference;
const MongoSchemaCollectionName = '_SCHEMA';

const storageAdapterAllCollections = mongoAdapter => {
  return mongoAdapter.connect().then(() => mongoAdapter.database.collections()).then(collections => {
    return collections.filter(collection => {
      if (collection.namespace.match(/\.system\./)) {
        return false;
      } // TODO: If you have one app with a collection prefix that happens to be a prefix of another
      // apps prefix, this will go very very badly. We should fix that somehow.


      return collection.collectionName.indexOf(mongoAdapter._collectionPrefix) == 0;
    });
  });
};

const convertParseSchemaToMongoSchema = (_ref) => {
  let schema = _extends({}, _ref);

  delete schema.fields._rperm;
  delete schema.fields._wperm;

  if (schema.className === '_User') {
    // Legacy mongo adapter knows about the difference between password and _hashed_password.
    // Future database adapters will only know about _hashed_password.
    // Note: Parse Server will bring back password with injectDefaultSchema, so we don't need
    // to add _hashed_password back ever.
    delete schema.fields._hashed_password;
  }

  return schema;
}; // Returns { code, error } if invalid, or { result }, an object
// suitable for inserting into _SCHEMA collection, otherwise.


const mongoSchemaFromFieldsAndClassNameAndCLP = (fields, className, classLevelPermissions, indexes) => {
  const mongoObject = {
    _id: className,
    objectId: 'string',
    updatedAt: 'string',
    createdAt: 'string',
    _metadata: undefined
  };

  for (const fieldName in fields) {
    mongoObject[fieldName] = _MongoSchemaCollection.default.parseFieldTypeToMongoFieldType(fields[fieldName]);
  }

  if (typeof classLevelPermissions !== 'undefined') {
    mongoObject._metadata = mongoObject._metadata || {};

    if (!classLevelPermissions) {
      delete mongoObject._metadata.class_permissions;
    } else {
      mongoObject._metadata.class_permissions = classLevelPermissions;
    }
  }

  if (indexes && typeof indexes === 'object' && Object.keys(indexes).length > 0) {
    mongoObject._metadata = mongoObject._metadata || {};
    mongoObject._metadata.indexes = indexes;
  }

  if (!mongoObject._metadata) {
    // cleanup the unused _metadata
    delete mongoObject._metadata;
  }

  return mongoObject;
};

class MongoStorageAdapter {
  // Private
  // Public
  constructor({
    uri = _defaults.default.DefaultMongoURI,
    collectionPrefix = '',
    mongoOptions = {}
  }) {
    this._uri = uri;
    this._collectionPrefix = collectionPrefix;
    this._mongoOptions = mongoOptions;
    this._mongoOptions.useNewUrlParser = true; // MaxTimeMS is not a global MongoDB client option, it is applied per operation.

    this._maxTimeMS = mongoOptions.maxTimeMS;
    this.canSortOnJoinTables = true;
    delete mongoOptions.maxTimeMS;
  }

  connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    } // parsing and re-formatting causes the auth value (if there) to get URI
    // encoded


    const encodedUri = (0, _mongodbUrl.format)((0, _mongodbUrl.parse)(this._uri));
    this.connectionPromise = MongoClient.connect(encodedUri, this._mongoOptions).then(client => {
      // Starting mongoDB 3.0, the MongoClient.connect don't return a DB anymore but a client
      // Fortunately, we can get back the options and use them to select the proper DB.
      // https://github.com/mongodb/node-mongodb-native/blob/2c35d76f08574225b8db02d7bef687123e6bb018/lib/mongo_client.js#L885
      const options = client.s.options;
      const database = client.db(options.dbName);

      if (!database) {
        delete this.connectionPromise;
        return;
      }

      database.on('error', () => {
        delete this.connectionPromise;
      });
      database.on('close', () => {
        delete this.connectionPromise;
      });
      this.client = client;
      this.database = database;
    }).catch(err => {
      delete this.connectionPromise;
      return Promise.reject(err);
    });
    return this.connectionPromise;
  }

  handleError(error) {
    if (error && error.code === 13) {
      // Unauthorized error
      delete this.client;
      delete this.database;
      delete this.connectionPromise;

      _logger.default.error('Received unauthorized error', {
        error: error
      });
    }

    throw error;
  }

  handleShutdown() {
    if (!this.client) {
      return;
    }

    this.client.close(false);
  }

  _adaptiveCollection(name) {
    return this.connect().then(() => this.database.collection(this._collectionPrefix + name)).then(rawCollection => new _MongoCollection.default(rawCollection)).catch(err => this.handleError(err));
  }

  _schemaCollection() {
    return this.connect().then(() => this._adaptiveCollection(MongoSchemaCollectionName)).then(collection => new _MongoSchemaCollection.default(collection));
  }

  classExists(name) {
    return this.connect().then(() => {
      return this.database.listCollections({
        name: this._collectionPrefix + name
      }).toArray();
    }).then(collections => {
      return collections.length > 0;
    }).catch(err => this.handleError(err));
  }

  setClassLevelPermissions(className, CLPs) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: {
        '_metadata.class_permissions': CLPs
      }
    })).catch(err => this.handleError(err));
  }

  setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields) {
    if (submittedIndexes === undefined) {
      return Promise.resolve();
    }

    if (Object.keys(existingIndexes).length === 0) {
      existingIndexes = {
        _id_: {
          _id: 1
        }
      };
    }

    const deletePromises = [];
    const insertedIndexes = [];
    Object.keys(submittedIndexes).forEach(name => {
      const field = submittedIndexes[name];

      if (existingIndexes[name] && field.__op !== 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
      }

      if (!existingIndexes[name] && field.__op === 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} does not exist, cannot delete.`);
      }

      if (field.__op === 'Delete') {
        const promise = this.dropIndex(className, name);
        deletePromises.push(promise);
        delete existingIndexes[name];
      } else {
        Object.keys(field).forEach(key => {
          if (!fields.hasOwnProperty(key)) {
            throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Field ${key} does not exist, cannot add index.`);
          }
        });
        existingIndexes[name] = field;
        insertedIndexes.push({
          key: field,
          name
        });
      }
    });
    let insertPromise = Promise.resolve();

    if (insertedIndexes.length > 0) {
      insertPromise = this.createIndexes(className, insertedIndexes);
    }

    return Promise.all(deletePromises).then(() => insertPromise).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, {
      $set: {
        '_metadata.indexes': existingIndexes
      }
    })).catch(err => this.handleError(err));
  }

  setIndexesFromMongo(className) {
    return this.getIndexes(className).then(indexes => {
      indexes = indexes.reduce((obj, index) => {
        if (index.key._fts) {
          delete index.key._fts;
          delete index.key._ftsx;

          for (const field in index.weights) {
            index.key[field] = 'text';
          }
        }

        obj[index.name] = index.key;
        return obj;
      }, {});
      return this._schemaCollection().then(schemaCollection => schemaCollection.updateSchema(className, {
        $set: {
          '_metadata.indexes': indexes
        }
      }));
    }).catch(err => this.handleError(err)).catch(() => {
      // Ignore if collection not found
      return Promise.resolve();
    });
  }

  createClass(className, schema) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = mongoSchemaFromFieldsAndClassNameAndCLP(schema.fields, className, schema.classLevelPermissions, schema.indexes);
    mongoObject._id = className;
    return this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.insertSchema(mongoObject)).catch(err => this.handleError(err));
  }

  addFieldIfNotExists(className, fieldName, type) {
    return this._schemaCollection().then(schemaCollection => schemaCollection.addFieldIfNotExists(className, fieldName, type)).then(() => this.createIndexesIfNeeded(className, fieldName, type)).catch(err => this.handleError(err));
  } // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.


  deleteClass(className) {
    return this._adaptiveCollection(className).then(collection => collection.drop()).catch(error => {
      // 'ns not found' means collection was already gone. Ignore deletion attempt.
      if (error.message == 'ns not found') {
        return;
      }

      throw error;
    }) // We've dropped the collection, now remove the _SCHEMA document
    .then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.findAndDeleteSchema(className)).catch(err => this.handleError(err));
  }

  deleteAllClasses(fast) {
    return storageAdapterAllCollections(this).then(collections => Promise.all(collections.map(collection => fast ? collection.deleteMany({}) : collection.drop())));
  } // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.
  // Pointer field names are passed for legacy reasons: the original mongo
  // format stored pointer field names differently in the database, and therefore
  // needed to know the type of the field before it could delete it. Future database
  // adapters should ignore the pointerFieldNames argument. All the field names are in
  // fieldNames, they show up additionally in the pointerFieldNames database for use
  // by the mongo adapter, which deals with the legacy mongo format.
  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.
  // Returns a Promise.


  deleteFields(className, schema, fieldNames) {
    const mongoFormatNames = fieldNames.map(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer') {
        return `_p_${fieldName}`;
      } else {
        return fieldName;
      }
    });
    const collectionUpdate = {
      $unset: {}
    };
    mongoFormatNames.forEach(name => {
      collectionUpdate['$unset'][name] = null;
    });
    const schemaUpdate = {
      $unset: {}
    };
    fieldNames.forEach(name => {
      schemaUpdate['$unset'][name] = null;
    });
    return this._adaptiveCollection(className).then(collection => collection.updateMany({}, collectionUpdate)).then(() => this._schemaCollection()).then(schemaCollection => schemaCollection.updateSchema(className, schemaUpdate)).catch(err => this.handleError(err));
  } // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.


  getAllClasses() {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchAllSchemasFrom_SCHEMA()).catch(err => this.handleError(err));
  } // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.


  getClass(className) {
    return this._schemaCollection().then(schemasCollection => schemasCollection._fetchOneSchemaFrom_SCHEMA(className)).catch(err => this.handleError(err));
  } // TODO: As yet not particularly well specified. Creates an object. Maybe shouldn't even need the schema,
  // and should infer from the type. Or maybe does need the schema for validations. Or maybe needs
  // the schema only for the legacy mongo format. We'll figure that out later.


  createObject(className, schema, object) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoObject = (0, _MongoTransform.parseObjectToMongoObjectForCreate)(className, object, schema);
    return this._adaptiveCollection(className).then(collection => collection.insertOne(mongoObject)).catch(error => {
      if (error.code === 11000) {
        // Duplicate value
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;

        if (error.message) {
          const matches = error.message.match(/index:[\sa-zA-Z0-9_\-\.]+\$?([a-zA-Z_-]+)_1/);

          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
        }

        throw err;
      }

      throw error;
    }).catch(err => this.handleError(err));
  } // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.


  deleteObjectsByQuery(className, schema, query) {
    schema = convertParseSchemaToMongoSchema(schema);
    return this._adaptiveCollection(className).then(collection => {
      const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
      return collection.deleteMany(mongoWhere);
    }).catch(err => this.handleError(err)).then(({
      result
    }) => {
      if (result.n === 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }

      return Promise.resolve();
    }, () => {
      throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'Database adapter error');
    });
  } // Apply the update to all objects that match the given Parse Query.


  updateObjectsByQuery(className, schema, query, update) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.updateMany(mongoWhere, mongoUpdate)).catch(err => this.handleError(err));
  } // Atomically finds and updates an object based on query.
  // Return value not currently well specified.


  findOneAndUpdate(className, schema, query, update) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.findOneAndUpdate(mongoWhere, mongoUpdate, {
      returnOriginal: false
    })).then(result => (0, _MongoTransform.mongoObjectToParseObject)(className, result.value, schema)).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      }

      throw error;
    }).catch(err => this.handleError(err));
  } // Hopefully we can get rid of this. It's only used for config and hooks.


  upsertOneObject(className, schema, query, update) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoUpdate = (0, _MongoTransform.transformUpdate)(className, update, schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);
    return this._adaptiveCollection(className).then(collection => collection.upsertOne(mongoWhere, mongoUpdate)).catch(err => this.handleError(err));
  } // Executes a find. Accepts: className, query in Parse format, and { skip, limit, sort }.


  find(className, schema, query, {
    skip,
    limit,
    sort,
    keys,
    readPreference
  }) {
    schema = convertParseSchemaToMongoSchema(schema);
    const mongoWhere = (0, _MongoTransform.transformWhere)(className, query, schema);

    const mongoSort = _lodash.default.mapKeys(sort, (value, fieldName) => (0, _MongoTransform.transformKey)(className, fieldName, schema));

    const mongoKeys = _lodash.default.reduce(keys, (memo, key) => {
      if (key === 'ACL') {
        memo['_rperm'] = 1;
        memo['_wperm'] = 1;
      } else {
        memo[(0, _MongoTransform.transformKey)(className, key, schema)] = 1;
      }

      return memo;
    }, {});

    readPreference = this._parseReadPreference(readPreference);
    return this.createTextIndexesIfNeeded(className, query, schema).then(() => this._adaptiveCollection(className)).then(collection => collection.find(mongoWhere, {
      skip,
      limit,
      sort: mongoSort,
      keys: mongoKeys,
      maxTimeMS: this._maxTimeMS,
      readPreference
    })).then(objects => objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema))).catch(err => this.handleError(err));
  } // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.


  ensureUniqueness(className, schema, fieldNames) {
    schema = convertParseSchemaToMongoSchema(schema);
    const indexCreationRequest = {};
    const mongoFieldNames = fieldNames.map(fieldName => (0, _MongoTransform.transformKey)(className, fieldName, schema));
    mongoFieldNames.forEach(fieldName => {
      indexCreationRequest[fieldName] = 1;
    });
    return this._adaptiveCollection(className).then(collection => collection._ensureSparseUniqueIndexInBackground(indexCreationRequest)).catch(error => {
      if (error.code === 11000) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'Tried to ensure field uniqueness for a class that already has duplicates.');
      }

      throw error;
    }).catch(err => this.handleError(err));
  } // Used in tests


  _rawFind(className, query) {
    return this._adaptiveCollection(className).then(collection => collection.find(query, {
      maxTimeMS: this._maxTimeMS
    })).catch(err => this.handleError(err));
  } // Executes a count.


  count(className, schema, query, readPreference) {
    schema = convertParseSchemaToMongoSchema(schema);
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.count((0, _MongoTransform.transformWhere)(className, query, schema, true), {
      maxTimeMS: this._maxTimeMS,
      readPreference
    })).catch(err => this.handleError(err));
  }

  distinct(className, schema, query, fieldName) {
    schema = convertParseSchemaToMongoSchema(schema);
    const isPointerField = schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    const transformField = (0, _MongoTransform.transformKey)(className, fieldName, schema);
    return this._adaptiveCollection(className).then(collection => collection.distinct(transformField, (0, _MongoTransform.transformWhere)(className, query, schema))).then(objects => {
      objects = objects.filter(obj => obj != null);
      return objects.map(object => {
        if (isPointerField) {
          return (0, _MongoTransform.transformPointerString)(schema, fieldName, object);
        }

        return (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema);
      });
    }).catch(err => this.handleError(err));
  }

  aggregate(className, schema, pipeline, readPreference) {
    let isPointerField = false;
    pipeline = pipeline.map(stage => {
      if (stage.$group) {
        stage.$group = this._parseAggregateGroupArgs(schema, stage.$group);

        if (stage.$group._id && typeof stage.$group._id === 'string' && stage.$group._id.indexOf('$_p_') >= 0) {
          isPointerField = true;
        }
      }

      if (stage.$match) {
        stage.$match = this._parseAggregateArgs(schema, stage.$match);
      }

      if (stage.$project) {
        stage.$project = this._parseAggregateProjectArgs(schema, stage.$project);
      }

      return stage;
    });
    readPreference = this._parseReadPreference(readPreference);
    return this._adaptiveCollection(className).then(collection => collection.aggregate(pipeline, {
      readPreference,
      maxTimeMS: this._maxTimeMS
    })).then(results => {
      results.forEach(result => {
        if (result.hasOwnProperty('_id')) {
          if (isPointerField && result._id) {
            result._id = result._id.split('$')[1];
          }

          if (result._id == null || _lodash.default.isEmpty(result._id)) {
            result._id = null;
          }

          result.objectId = result._id;
          delete result._id;
        }
      });
      return results;
    }).then(objects => objects.map(object => (0, _MongoTransform.mongoObjectToParseObject)(className, object, schema))).catch(err => this.handleError(err));
  } // This function will recursively traverse the pipeline and convert any Pointer or Date columns.
  // If we detect a pointer column we will rename the column being queried for to match the column
  // in the database. We also modify the value to what we expect the value to be in the database
  // as well.
  // For dates, the driver expects a Date object, but we have a string coming in. So we'll convert
  // the string to a Date so the driver can perform the necessary comparison.
  //
  // The goal of this method is to look for the "leaves" of the pipeline and determine if it needs
  // to be converted. The pipeline can have a few different forms. For more details, see:
  //     https://docs.mongodb.com/manual/reference/operator/aggregation/
  //
  // If the pipeline is an array, it means we are probably parsing an '$and' or '$or' operator. In
  // that case we need to loop through all of it's children to find the columns being operated on.
  // If the pipeline is an object, then we'll loop through the keys checking to see if the key name
  // matches one of the schema columns. If it does match a column and the column is a Pointer or
  // a Date, then we'll convert the value as described above.
  //
  // As much as I hate recursion...this seemed like a good fit for it. We're essentially traversing
  // down a tree to find a "leaf node" and checking to see if it needs to be converted.


  _parseAggregateArgs(schema, pipeline) {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateArgs(schema, value));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};

      for (const field in pipeline) {
        if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
          if (typeof pipeline[field] === 'object') {
            // Pass objects down to MongoDB...this is more than likely an $exists operator.
            returnValue[`_p_${field}`] = pipeline[field];
          } else {
            returnValue[`_p_${field}`] = `${schema.fields[field].targetClass}$${pipeline[field]}`;
          }
        } else if (schema.fields[field] && schema.fields[field].type === 'Date') {
          returnValue[field] = this._convertToDate(pipeline[field]);
        } else {
          returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
        }

        if (field === 'objectId') {
          returnValue['_id'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'createdAt') {
          returnValue['_created_at'] = returnValue[field];
          delete returnValue[field];
        } else if (field === 'updatedAt') {
          returnValue['_updated_at'] = returnValue[field];
          delete returnValue[field];
        }
      }

      return returnValue;
    }

    return pipeline;
  } // This function is slightly different than the one above. Rather than trying to combine these
  // two functions and making the code even harder to understand, I decided to split it up. The
  // difference with this function is we are not transforming the values, only the keys of the
  // pipeline.


  _parseAggregateProjectArgs(schema, pipeline) {
    const returnValue = {};

    for (const field in pipeline) {
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        returnValue[`_p_${field}`] = pipeline[field];
      } else {
        returnValue[field] = this._parseAggregateArgs(schema, pipeline[field]);
      }

      if (field === 'objectId') {
        returnValue['_id'] = returnValue[field];
        delete returnValue[field];
      } else if (field === 'createdAt') {
        returnValue['_created_at'] = returnValue[field];
        delete returnValue[field];
      } else if (field === 'updatedAt') {
        returnValue['_updated_at'] = returnValue[field];
        delete returnValue[field];
      }
    }

    return returnValue;
  } // This function is slightly different than the two above. MongoDB $group aggregate looks like:
  //     { $group: { _id: <expression>, <field1>: { <accumulator1> : <expression1> }, ... } }
  // The <expression> could be a column name, prefixed with the '$' character. We'll look for
  // these <expression> and check to see if it is a 'Pointer' or if it's one of createdAt,
  // updatedAt or objectId and change it accordingly.


  _parseAggregateGroupArgs(schema, pipeline) {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._parseAggregateGroupArgs(schema, value));
    } else if (typeof pipeline === 'object') {
      const returnValue = {};

      for (const field in pipeline) {
        returnValue[field] = this._parseAggregateGroupArgs(schema, pipeline[field]);
      }

      return returnValue;
    } else if (typeof pipeline === 'string') {
      const field = pipeline.substring(1);

      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        return `$_p_${field}`;
      } else if (field == 'createdAt') {
        return '$_created_at';
      } else if (field == 'updatedAt') {
        return '$_updated_at';
      }
    }

    return pipeline;
  } // This function will attempt to convert the provided value to a Date object. Since this is part
  // of an aggregation pipeline, the value can either be a string or it can be another object with
  // an operator in it (like $gt, $lt, etc). Because of this I felt it was easier to make this a
  // recursive method to traverse down to the "leaf node" which is going to be the string.


  _convertToDate(value) {
    if (typeof value === 'string') {
      return new Date(value);
    }

    const returnValue = {};

    for (const field in value) {
      returnValue[field] = this._convertToDate(value[field]);
    }

    return returnValue;
  }

  _parseReadPreference(readPreference) {
    if (readPreference) {
      readPreference = readPreference.toUpperCase();
    }

    switch (readPreference) {
      case 'PRIMARY':
        readPreference = ReadPreference.PRIMARY;
        break;

      case 'PRIMARY_PREFERRED':
        readPreference = ReadPreference.PRIMARY_PREFERRED;
        break;

      case 'SECONDARY':
        readPreference = ReadPreference.SECONDARY;
        break;

      case 'SECONDARY_PREFERRED':
        readPreference = ReadPreference.SECONDARY_PREFERRED;
        break;

      case 'NEAREST':
        readPreference = ReadPreference.NEAREST;
        break;

      case undefined:
      case null:
      case '':
        break;

      default:
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, 'Not supported read preference.');
    }

    return readPreference;
  }

  performInitialization() {
    return Promise.resolve();
  }

  createIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndex(index)).catch(err => this.handleError(err));
  }

  createIndexes(className, indexes) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.createIndexes(indexes)).catch(err => this.handleError(err));
  }

  createIndexesIfNeeded(className, fieldName, type) {
    if (type && type.type === 'Polygon') {
      const index = {
        [fieldName]: '2dsphere'
      };
      return this.createIndex(className, index);
    }

    return Promise.resolve();
  }

  createTextIndexesIfNeeded(className, query, schema) {
    for (const fieldName in query) {
      if (!query[fieldName] || !query[fieldName].$text) {
        continue;
      }

      const existingIndexes = schema.indexes;

      for (const key in existingIndexes) {
        const index = existingIndexes[key];

        if (index.hasOwnProperty(fieldName)) {
          return Promise.resolve();
        }
      }

      const indexName = `${fieldName}_text`;
      const textIndex = {
        [indexName]: {
          [fieldName]: 'text'
        }
      };
      return this.setIndexesWithSchemaFormat(className, textIndex, existingIndexes, schema.fields).catch(error => {
        if (error.code === 85) {
          // Index exist with different options
          return this.setIndexesFromMongo(className);
        }

        throw error;
      });
    }

    return Promise.resolve();
  }

  getIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.indexes()).catch(err => this.handleError(err));
  }

  dropIndex(className, index) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndex(index)).catch(err => this.handleError(err));
  }

  dropAllIndexes(className) {
    return this._adaptiveCollection(className).then(collection => collection._mongoCollection.dropIndexes()).catch(err => this.handleError(err));
  }

  updateSchemaWithIndexes() {
    return this.getAllClasses().then(classes => {
      const promises = classes.map(schema => {
        return this.setIndexesFromMongo(schema.className);
      });
      return Promise.all(promises);
    }).catch(err => this.handleError(err));
  }

}

exports.MongoStorageAdapter = MongoStorageAdapter;
var _default = MongoStorageAdapter;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvU3RvcmFnZUFkYXB0ZXIuanMiXSwibmFtZXMiOlsibW9uZ29kYiIsInJlcXVpcmUiLCJNb25nb0NsaWVudCIsIlJlYWRQcmVmZXJlbmNlIiwiTW9uZ29TY2hlbWFDb2xsZWN0aW9uTmFtZSIsInN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMiLCJtb25nb0FkYXB0ZXIiLCJjb25uZWN0IiwidGhlbiIsImRhdGFiYXNlIiwiY29sbGVjdGlvbnMiLCJmaWx0ZXIiLCJjb2xsZWN0aW9uIiwibmFtZXNwYWNlIiwibWF0Y2giLCJjb2xsZWN0aW9uTmFtZSIsImluZGV4T2YiLCJfY29sbGVjdGlvblByZWZpeCIsImNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEiLCJzY2hlbWEiLCJmaWVsZHMiLCJfcnBlcm0iLCJfd3Blcm0iLCJjbGFzc05hbWUiLCJfaGFzaGVkX3Bhc3N3b3JkIiwibW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQIiwiY2xhc3NMZXZlbFBlcm1pc3Npb25zIiwiaW5kZXhlcyIsIm1vbmdvT2JqZWN0IiwiX2lkIiwib2JqZWN0SWQiLCJ1cGRhdGVkQXQiLCJjcmVhdGVkQXQiLCJfbWV0YWRhdGEiLCJ1bmRlZmluZWQiLCJmaWVsZE5hbWUiLCJNb25nb1NjaGVtYUNvbGxlY3Rpb24iLCJwYXJzZUZpZWxkVHlwZVRvTW9uZ29GaWVsZFR5cGUiLCJjbGFzc19wZXJtaXNzaW9ucyIsIk9iamVjdCIsImtleXMiLCJsZW5ndGgiLCJNb25nb1N0b3JhZ2VBZGFwdGVyIiwiY29uc3RydWN0b3IiLCJ1cmkiLCJkZWZhdWx0cyIsIkRlZmF1bHRNb25nb1VSSSIsImNvbGxlY3Rpb25QcmVmaXgiLCJtb25nb09wdGlvbnMiLCJfdXJpIiwiX21vbmdvT3B0aW9ucyIsInVzZU5ld1VybFBhcnNlciIsIl9tYXhUaW1lTVMiLCJtYXhUaW1lTVMiLCJjYW5Tb3J0T25Kb2luVGFibGVzIiwiY29ubmVjdGlvblByb21pc2UiLCJlbmNvZGVkVXJpIiwiY2xpZW50Iiwib3B0aW9ucyIsInMiLCJkYiIsImRiTmFtZSIsIm9uIiwiY2F0Y2giLCJlcnIiLCJQcm9taXNlIiwicmVqZWN0IiwiaGFuZGxlRXJyb3IiLCJlcnJvciIsImNvZGUiLCJsb2dnZXIiLCJoYW5kbGVTaHV0ZG93biIsImNsb3NlIiwiX2FkYXB0aXZlQ29sbGVjdGlvbiIsIm5hbWUiLCJyYXdDb2xsZWN0aW9uIiwiTW9uZ29Db2xsZWN0aW9uIiwiX3NjaGVtYUNvbGxlY3Rpb24iLCJjbGFzc0V4aXN0cyIsImxpc3RDb2xsZWN0aW9ucyIsInRvQXJyYXkiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJDTFBzIiwic2NoZW1hQ29sbGVjdGlvbiIsInVwZGF0ZVNjaGVtYSIsIiRzZXQiLCJzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdCIsInN1Ym1pdHRlZEluZGV4ZXMiLCJleGlzdGluZ0luZGV4ZXMiLCJyZXNvbHZlIiwiX2lkXyIsImRlbGV0ZVByb21pc2VzIiwiaW5zZXJ0ZWRJbmRleGVzIiwiZm9yRWFjaCIsImZpZWxkIiwiX19vcCIsIlBhcnNlIiwiRXJyb3IiLCJJTlZBTElEX1FVRVJZIiwicHJvbWlzZSIsImRyb3BJbmRleCIsInB1c2giLCJrZXkiLCJoYXNPd25Qcm9wZXJ0eSIsImluc2VydFByb21pc2UiLCJjcmVhdGVJbmRleGVzIiwiYWxsIiwic2V0SW5kZXhlc0Zyb21Nb25nbyIsImdldEluZGV4ZXMiLCJyZWR1Y2UiLCJvYmoiLCJpbmRleCIsIl9mdHMiLCJfZnRzeCIsIndlaWdodHMiLCJjcmVhdGVDbGFzcyIsImluc2VydFNjaGVtYSIsImFkZEZpZWxkSWZOb3RFeGlzdHMiLCJ0eXBlIiwiY3JlYXRlSW5kZXhlc0lmTmVlZGVkIiwiZGVsZXRlQ2xhc3MiLCJkcm9wIiwibWVzc2FnZSIsImZpbmRBbmREZWxldGVTY2hlbWEiLCJkZWxldGVBbGxDbGFzc2VzIiwiZmFzdCIsIm1hcCIsImRlbGV0ZU1hbnkiLCJkZWxldGVGaWVsZHMiLCJmaWVsZE5hbWVzIiwibW9uZ29Gb3JtYXROYW1lcyIsImNvbGxlY3Rpb25VcGRhdGUiLCIkdW5zZXQiLCJzY2hlbWFVcGRhdGUiLCJ1cGRhdGVNYW55IiwiZ2V0QWxsQ2xhc3NlcyIsInNjaGVtYXNDb2xsZWN0aW9uIiwiX2ZldGNoQWxsU2NoZW1hc0Zyb21fU0NIRU1BIiwiZ2V0Q2xhc3MiLCJfZmV0Y2hPbmVTY2hlbWFGcm9tX1NDSEVNQSIsImNyZWF0ZU9iamVjdCIsIm9iamVjdCIsImluc2VydE9uZSIsIkRVUExJQ0FURV9WQUxVRSIsInVuZGVybHlpbmdFcnJvciIsIm1hdGNoZXMiLCJBcnJheSIsImlzQXJyYXkiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJkZWxldGVPYmplY3RzQnlRdWVyeSIsInF1ZXJ5IiwibW9uZ29XaGVyZSIsInJlc3VsdCIsIm4iLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwidXBkYXRlT2JqZWN0c0J5UXVlcnkiLCJ1cGRhdGUiLCJtb25nb1VwZGF0ZSIsImZpbmRPbmVBbmRVcGRhdGUiLCJfbW9uZ29Db2xsZWN0aW9uIiwicmV0dXJuT3JpZ2luYWwiLCJ2YWx1ZSIsInVwc2VydE9uZU9iamVjdCIsInVwc2VydE9uZSIsImZpbmQiLCJza2lwIiwibGltaXQiLCJzb3J0IiwicmVhZFByZWZlcmVuY2UiLCJtb25nb1NvcnQiLCJfIiwibWFwS2V5cyIsIm1vbmdvS2V5cyIsIm1lbW8iLCJfcGFyc2VSZWFkUHJlZmVyZW5jZSIsImNyZWF0ZVRleHRJbmRleGVzSWZOZWVkZWQiLCJvYmplY3RzIiwiZW5zdXJlVW5pcXVlbmVzcyIsImluZGV4Q3JlYXRpb25SZXF1ZXN0IiwibW9uZ29GaWVsZE5hbWVzIiwiX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kIiwiX3Jhd0ZpbmQiLCJjb3VudCIsImRpc3RpbmN0IiwiaXNQb2ludGVyRmllbGQiLCJ0cmFuc2Zvcm1GaWVsZCIsImFnZ3JlZ2F0ZSIsInBpcGVsaW5lIiwic3RhZ2UiLCIkZ3JvdXAiLCJfcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3MiLCIkbWF0Y2giLCJfcGFyc2VBZ2dyZWdhdGVBcmdzIiwiJHByb2plY3QiLCJfcGFyc2VBZ2dyZWdhdGVQcm9qZWN0QXJncyIsInJlc3VsdHMiLCJzcGxpdCIsImlzRW1wdHkiLCJyZXR1cm5WYWx1ZSIsInRhcmdldENsYXNzIiwiX2NvbnZlcnRUb0RhdGUiLCJzdWJzdHJpbmciLCJEYXRlIiwidG9VcHBlckNhc2UiLCJQUklNQVJZIiwiUFJJTUFSWV9QUkVGRVJSRUQiLCJTRUNPTkRBUlkiLCJTRUNPTkRBUllfUFJFRkVSUkVEIiwiTkVBUkVTVCIsInBlcmZvcm1Jbml0aWFsaXphdGlvbiIsImNyZWF0ZUluZGV4IiwiJHRleHQiLCJpbmRleE5hbWUiLCJ0ZXh0SW5kZXgiLCJkcm9wQWxsSW5kZXhlcyIsImRyb3BJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJjbGFzc2VzIiwicHJvbWlzZXMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFDQTs7QUFDQTs7QUFDQTs7QUFPQTs7QUFJQTs7QUFTQTs7QUFFQTs7QUFDQTs7QUFDQTs7Ozs7O0FBRUE7QUFDQSxNQUFNQSxPQUFPLEdBQUdDLE9BQU8sQ0FBQyxTQUFELENBQXZCOztBQUNBLE1BQU1DLFdBQVcsR0FBR0YsT0FBTyxDQUFDRSxXQUE1QjtBQUNBLE1BQU1DLGNBQWMsR0FBR0gsT0FBTyxDQUFDRyxjQUEvQjtBQUVBLE1BQU1DLHlCQUF5QixHQUFHLFNBQWxDOztBQUVBLE1BQU1DLDRCQUE0QixHQUFHQyxZQUFZLElBQUk7QUFDbkQsU0FBT0EsWUFBWSxDQUNoQkMsT0FESSxHQUVKQyxJQUZJLENBRUMsTUFBTUYsWUFBWSxDQUFDRyxRQUFiLENBQXNCQyxXQUF0QixFQUZQLEVBR0pGLElBSEksQ0FHQ0UsV0FBVyxJQUFJO0FBQ25CLFdBQU9BLFdBQVcsQ0FBQ0MsTUFBWixDQUFtQkMsVUFBVSxJQUFJ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QUZULENBQVA7QUFHRDs7QUFFRHdKLEVBQUFBLGNBQWMsQ0FBQ2pNLFNBQUQsRUFBb0I7QUFDaEMsV0FBTyxLQUFLa0QsbUJBQUwsQ0FBeUJsRCxTQUF6QixFQUNKZixJQURJLENBQ0NJLFVBQVUsSUFBSUEsVUFBVSxDQUFDcUosZ0JBQVgsQ0FBNEJ3RCxXQUE1QixFQURmLEVBRUoxSixLQUZJLENBRUVDLEdBQUcsSUFBSSxLQUFLRyxXQUFMLENBQWlCSCxHQUFqQixDQUZULENBQVA7QUFHRDs7QUFFRDBKLEVBQUFBLHVCQUF1QixHQUFpQjtBQUN0QyxXQUFPLEtBQUtuRixhQUFMLEdBQ0ovSCxJQURJLENBQ0NtTixPQUFPLElBQUk7QUFDZixZQUFNQyxRQUFRLEdBQUdELE9BQU8sQ0FBQzdGLEdBQVIsQ0FBWTNHLE1BQU0sSUFBSTtBQUNyQyxlQUFPLEtBQUt3RixtQkFBTCxDQUF5QnhGLE1BQU0sQ0FBQ0ksU0FBaEMsQ0FBUDtBQUNELE9BRmdCLENBQWpCO0FBR0EsYUFBTzBDLE9BQU8sQ0FBQ3lDLEdBQVIsQ0FBWWtILFFBQVosQ0FBUDtBQUNELEtBTkksRUFPSjdKLEtBUEksQ0FPRUMsR0FBRyxJQUFJLEtBQUtHLFdBQUwsQ0FBaUJILEdBQWpCLENBUFQsQ0FBUDtBQVFEOztBQXA2QndEOzs7ZUF1NkI1Q3RCLG1CIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQGZsb3dcbmltcG9ydCBNb25nb0NvbGxlY3Rpb24gZnJvbSAnLi9Nb25nb0NvbGxlY3Rpb24nO1xuaW1wb3J0IE1vbmdvU2NoZW1hQ29sbGVjdGlvbiBmcm9tICcuL01vbmdvU2NoZW1hQ29sbGVjdGlvbic7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCB0eXBlIHtcbiAgU2NoZW1hVHlwZSxcbiAgUXVlcnlUeXBlLFxuICBTdG9yYWdlQ2xhc3MsXG4gIFF1ZXJ5T3B0aW9ucyxcbn0gZnJvbSAnLi4vU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHtcbiAgcGFyc2UgYXMgcGFyc2VVcmwsXG4gIGZvcm1hdCBhcyBmb3JtYXRVcmwsXG59IGZyb20gJy4uLy4uLy4uL3ZlbmRvci9tb25nb2RiVXJsJztcbmltcG9ydCB7XG4gIHBhcnNlT2JqZWN0VG9Nb25nb09iamVjdEZvckNyZWF0ZSxcbiAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0LFxuICB0cmFuc2Zvcm1LZXksXG4gIHRyYW5zZm9ybVdoZXJlLFxuICB0cmFuc2Zvcm1VcGRhdGUsXG4gIHRyYW5zZm9ybVBvaW50ZXJTdHJpbmcsXG59IGZyb20gJy4vTW9uZ29UcmFuc2Zvcm0nO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgZGVmYXVsdHMgZnJvbSAnLi4vLi4vLi4vZGVmYXVsdHMnO1xuaW1wb3J0IGxvZ2dlciBmcm9tICcuLi8uLi8uLi9sb2dnZXInO1xuXG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmNvbnN0IG1vbmdvZGIgPSByZXF1aXJlKCdtb25nb2RiJyk7XG5jb25zdCBNb25nb0NsaWVudCA9IG1vbmdvZGIuTW9uZ29DbGllbnQ7XG5jb25zdCBSZWFkUHJlZmVyZW5jZSA9IG1vbmdvZGIuUmVhZFByZWZlcmVuY2U7XG5cbmNvbnN0IE1vbmdvU2NoZW1hQ29sbGVjdGlvbk5hbWUgPSAnX1NDSEVNQSc7XG5cbmNvbnN0IHN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnMgPSBtb25nb0FkYXB0ZXIgPT4ge1xuICByZXR1cm4gbW9uZ29BZGFwdGVyXG4gICAgLmNvbm5lY3QoKVxuICAgIC50aGVuKCgpID0+IG1vbmdvQWRhcHRlci5kYXRhYmFzZS5jb2xsZWN0aW9ucygpKVxuICAgIC50aGVuKGNvbGxlY3Rpb25zID0+IHtcbiAgICAgIHJldHVybiBjb2xsZWN0aW9ucy5maWx0ZXIoY29sbGVjdGlvbiA9PiB7XG4gICAgICAgIGlmIChjb2xsZWN0aW9uLm5hbWVzcGFjZS5tYXRjaCgvXFwuc3lzdGVtXFwuLykpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgLy8gVE9ETzogSWYgeW91IGhhdmUgb25lIGFwcCB3aXRoIGEgY29sbGVjdGlvbiBwcmVmaXggdGhhdCBoYXBwZW5zIHRvIGJlIGEgcHJlZml4IG9mIGFub3RoZXJcbiAgICAgICAgLy8gYXBwcyBwcmVmaXgsIHRoaXMgd2lsbCBnbyB2ZXJ5IHZlcnkgYmFkbHkuIFdlIHNob3VsZCBmaXggdGhhdCBzb21laG93LlxuICAgICAgICByZXR1cm4gKFxuICAgICAgICAgIGNvbGxlY3Rpb24uY29sbGVjdGlvbk5hbWUuaW5kZXhPZihtb25nb0FkYXB0ZXIuX2NvbGxlY3Rpb25QcmVmaXgpID09IDBcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0pO1xufTtcblxuY29uc3QgY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYSA9ICh7IC4uLnNjaGVtYSB9KSA9PiB7XG4gIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9ycGVybTtcbiAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3dwZXJtO1xuXG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgLy8gTGVnYWN5IG1vbmdvIGFkYXB0ZXIga25vd3MgYWJvdXQgdGhlIGRpZmZlcmVuY2UgYmV0d2VlbiBwYXNzd29yZCBhbmQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBGdXR1cmUgZGF0YWJhc2UgYWRhcHRlcnMgd2lsbCBvbmx5IGtub3cgYWJvdXQgX2hhc2hlZF9wYXNzd29yZC5cbiAgICAvLyBOb3RlOiBQYXJzZSBTZXJ2ZXIgd2lsbCBicmluZyBiYWNrIHBhc3N3b3JkIHdpdGggaW5qZWN0RGVmYXVsdFNjaGVtYSwgc28gd2UgZG9uJ3QgbmVlZFxuICAgIC8vIHRvIGFkZCBfaGFzaGVkX3Bhc3N3b3JkIGJhY2sgZXZlci5cbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkO1xuICB9XG5cbiAgcmV0dXJuIHNjaGVtYTtcbn07XG5cbi8vIFJldHVybnMgeyBjb2RlLCBlcnJvciB9IGlmIGludmFsaWQsIG9yIHsgcmVzdWx0IH0sIGFuIG9iamVjdFxuLy8gc3VpdGFibGUgZm9yIGluc2VydGluZyBpbnRvIF9TQ0hFTUEgY29sbGVjdGlvbiwgb3RoZXJ3aXNlLlxuY29uc3QgbW9uZ29TY2hlbWFGcm9tRmllbGRzQW5kQ2xhc3NOYW1lQW5kQ0xQID0gKFxuICBmaWVsZHMsXG4gIGNsYXNzTmFtZSxcbiAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICBpbmRleGVzXG4pID0+IHtcbiAgY29uc3QgbW9uZ29PYmplY3QgPSB7XG4gICAgX2lkOiBjbGFzc05hbWUsXG4gICAgb2JqZWN0SWQ6ICdzdHJpbmcnLFxuICAgIHVwZGF0ZWRBdDogJ3N0cmluZycsXG4gICAgY3JlYXRlZEF0OiAnc3RyaW5nJyxcbiAgICBfbWV0YWRhdGE6IHVuZGVmaW5lZCxcbiAgfTtcblxuICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBmaWVsZHMpIHtcbiAgICBtb25nb09iamVjdFtcbiAgICAgIGZpZWxkTmFtZVxuICAgIF0gPSBNb25nb1NjaGVtYUNvbGxlY3Rpb24ucGFyc2VGaWVsZFR5cGVUb01vbmdvRmllbGRUeXBlKGZpZWxkc1tmaWVsZE5hbWVdKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgY2xhc3NMZXZlbFBlcm1pc3Npb25zICE9PSAndW5kZWZpbmVkJykge1xuICAgIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSA9IG1vbmdvT2JqZWN0Ll9tZXRhZGF0YSB8fCB7fTtcbiAgICBpZiAoIWNsYXNzTGV2ZWxQZXJtaXNzaW9ucykge1xuICAgICAgZGVsZXRlIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucztcbiAgICB9IGVsc2Uge1xuICAgICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmNsYXNzX3Blcm1pc3Npb25zID0gY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgIH1cbiAgfVxuXG4gIGlmIChcbiAgICBpbmRleGVzICYmXG4gICAgdHlwZW9mIGluZGV4ZXMgPT09ICdvYmplY3QnICYmXG4gICAgT2JqZWN0LmtleXMoaW5kZXhlcykubGVuZ3RoID4gMFxuICApIHtcbiAgICBtb25nb09iamVjdC5fbWV0YWRhdGEgPSBtb25nb09iamVjdC5fbWV0YWRhdGEgfHwge307XG4gICAgbW9uZ29PYmplY3QuX21ldGFkYXRhLmluZGV4ZXMgPSBpbmRleGVzO1xuICB9XG5cbiAgaWYgKCFtb25nb09iamVjdC5fbWV0YWRhdGEpIHtcbiAgICAvLyBjbGVhbnVwIHRoZSB1bnVzZWQgX21ldGFkYXRhXG4gICAgZGVsZXRlIG1vbmdvT2JqZWN0Ll9tZXRhZGF0YTtcbiAgfVxuXG4gIHJldHVybiBtb25nb09iamVjdDtcbn07XG5cbmV4cG9ydCBjbGFzcyBNb25nb1N0b3JhZ2VBZGFwdGVyIGltcGxlbWVudHMgU3RvcmFnZUFkYXB0ZXIge1xuICAvLyBQcml2YXRlXG4gIF91cmk6IHN0cmluZztcbiAgX2NvbGxlY3Rpb25QcmVmaXg6IHN0cmluZztcbiAgX21vbmdvT3B0aW9uczogT2JqZWN0O1xuICAvLyBQdWJsaWNcbiAgY29ubmVjdGlvblByb21pc2U6IFByb21pc2U8YW55PjtcbiAgZGF0YWJhc2U6IGFueTtcbiAgY2xpZW50OiBNb25nb0NsaWVudDtcbiAgX21heFRpbWVNUzogP251bWJlcjtcbiAgY2FuU29ydE9uSm9pblRhYmxlczogYm9vbGVhbjtcblxuICBjb25zdHJ1Y3Rvcih7XG4gICAgdXJpID0gZGVmYXVsdHMuRGVmYXVsdE1vbmdvVVJJLFxuICAgIGNvbGxlY3Rpb25QcmVmaXggPSAnJyxcbiAgICBtb25nb09wdGlvbnMgPSB7fSxcbiAgfTogYW55KSB7XG4gICAgdGhpcy5fdXJpID0gdXJpO1xuICAgIHRoaXMuX2NvbGxlY3Rpb25QcmVmaXggPSBjb2xsZWN0aW9uUHJlZml4O1xuICAgIHRoaXMuX21vbmdvT3B0aW9ucyA9IG1vbmdvT3B0aW9ucztcbiAgICB0aGlzLl9tb25nb09wdGlvbnMudXNlTmV3VXJsUGFyc2VyID0gdHJ1ZTtcblxuICAgIC8vIE1heFRpbWVNUyBpcyBub3QgYSBnbG9iYWwgTW9uZ29EQiBjbGllbnQgb3B0aW9uLCBpdCBpcyBhcHBsaWVkIHBlciBvcGVyYXRpb24uXG4gICAgdGhpcy5fbWF4VGltZU1TID0gbW9uZ29PcHRpb25zLm1heFRpbWVNUztcbiAgICB0aGlzLmNhblNvcnRPbkpvaW5UYWJsZXMgPSB0cnVlO1xuICAgIGRlbGV0ZSBtb25nb09wdGlvbnMubWF4VGltZU1TO1xuICB9XG5cbiAgY29ubmVjdCgpIHtcbiAgICBpZiAodGhpcy5jb25uZWN0aW9uUHJvbWlzZSkge1xuICAgICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgfVxuXG4gICAgLy8gcGFyc2luZyBhbmQgcmUtZm9ybWF0dGluZyBjYXVzZXMgdGhlIGF1dGggdmFsdWUgKGlmIHRoZXJlKSB0byBnZXQgVVJJXG4gICAgLy8gZW5jb2RlZFxuICAgIGNvbnN0IGVuY29kZWRVcmkgPSBmb3JtYXRVcmwocGFyc2VVcmwodGhpcy5fdXJpKSk7XG5cbiAgICB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlID0gTW9uZ29DbGllbnQuY29ubmVjdChlbmNvZGVkVXJpLCB0aGlzLl9tb25nb09wdGlvbnMpXG4gICAgICAudGhlbihjbGllbnQgPT4ge1xuICAgICAgICAvLyBTdGFydGluZyBtb25nb0RCIDMuMCwgdGhlIE1vbmdvQ2xpZW50LmNvbm5lY3QgZG9uJ3QgcmV0dXJuIGEgREIgYW55bW9yZSBidXQgYSBjbGllbnRcbiAgICAgICAgLy8gRm9ydHVuYXRlbHksIHdlIGNhbiBnZXQgYmFjayB0aGUgb3B0aW9ucyBhbmQgdXNlIHRoZW0gdG8gc2VsZWN0IHRoZSBwcm9wZXIgREIuXG4gICAgICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9tb25nb2RiL25vZGUtbW9uZ29kYi1uYXRpdmUvYmxvYi8yYzM1ZDc2ZjA4NTc0MjI1YjhkYjAyZDdiZWY2ODcxMjNlNmJiMDE4L2xpYi9tb25nb19jbGllbnQuanMjTDg4NVxuICAgICAgICBjb25zdCBvcHRpb25zID0gY2xpZW50LnMub3B0aW9ucztcbiAgICAgICAgY29uc3QgZGF0YWJhc2UgPSBjbGllbnQuZGIob3B0aW9ucy5kYk5hbWUpO1xuICAgICAgICBpZiAoIWRhdGFiYXNlKSB7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGRhdGFiYXNlLm9uKCdlcnJvcicsICgpID0+IHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgfSk7XG4gICAgICAgIGRhdGFiYXNlLm9uKCdjbG9zZScsICgpID0+IHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5jb25uZWN0aW9uUHJvbWlzZTtcbiAgICAgICAgfSk7XG4gICAgICAgIHRoaXMuY2xpZW50ID0gY2xpZW50O1xuICAgICAgICB0aGlzLmRhdGFiYXNlID0gZGF0YWJhc2U7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyKTtcbiAgICAgIH0pO1xuXG4gICAgcmV0dXJuIHRoaXMuY29ubmVjdGlvblByb21pc2U7XG4gIH1cblxuICBoYW5kbGVFcnJvcjxUPihlcnJvcjogPyhFcnJvciB8IFBhcnNlLkVycm9yKSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSAxMykge1xuICAgICAgLy8gVW5hdXRob3JpemVkIGVycm9yXG4gICAgICBkZWxldGUgdGhpcy5jbGllbnQ7XG4gICAgICBkZWxldGUgdGhpcy5kYXRhYmFzZTtcbiAgICAgIGRlbGV0ZSB0aGlzLmNvbm5lY3Rpb25Qcm9taXNlO1xuICAgICAgbG9nZ2VyLmVycm9yKCdSZWNlaXZlZCB1bmF1dGhvcml6ZWQgZXJyb3InLCB7IGVycm9yOiBlcnJvciB9KTtcbiAgICB9XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cblxuICBoYW5kbGVTaHV0ZG93bigpIHtcbiAgICBpZiAoIXRoaXMuY2xpZW50KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuY2xpZW50LmNsb3NlKGZhbHNlKTtcbiAgfVxuXG4gIF9hZGFwdGl2ZUNvbGxlY3Rpb24obmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuY29ubmVjdCgpXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmRhdGFiYXNlLmNvbGxlY3Rpb24odGhpcy5fY29sbGVjdGlvblByZWZpeCArIG5hbWUpKVxuICAgICAgLnRoZW4ocmF3Q29sbGVjdGlvbiA9PiBuZXcgTW9uZ29Db2xsZWN0aW9uKHJhd0NvbGxlY3Rpb24pKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgX3NjaGVtYUNvbGxlY3Rpb24oKTogUHJvbWlzZTxNb25nb1NjaGVtYUNvbGxlY3Rpb24+IHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihNb25nb1NjaGVtYUNvbGxlY3Rpb25OYW1lKSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gbmV3IE1vbmdvU2NoZW1hQ29sbGVjdGlvbihjb2xsZWN0aW9uKSk7XG4gIH1cblxuICBjbGFzc0V4aXN0cyhuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5jb25uZWN0KClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGF0YWJhc2VcbiAgICAgICAgICAubGlzdENvbGxlY3Rpb25zKHsgbmFtZTogdGhpcy5fY29sbGVjdGlvblByZWZpeCArIG5hbWUgfSlcbiAgICAgICAgICAudG9BcnJheSgpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb25zID0+IHtcbiAgICAgICAgcmV0dXJuIGNvbGxlY3Rpb25zLmxlbmd0aCA+IDA7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZTogc3RyaW5nLCBDTFBzOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+XG4gICAgICAgIHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwge1xuICAgICAgICAgICRzZXQ6IHsgJ19tZXRhZGF0YS5jbGFzc19wZXJtaXNzaW9ucyc6IENMUHMgfSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHN1Ym1pdHRlZEluZGV4ZXM6IGFueSxcbiAgICBleGlzdGluZ0luZGV4ZXM6IGFueSA9IHt9LFxuICAgIGZpZWxkczogYW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChzdWJtaXR0ZWRJbmRleGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKGV4aXN0aW5nSW5kZXhlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICBleGlzdGluZ0luZGV4ZXMgPSB7IF9pZF86IHsgX2lkOiAxIH0gfTtcbiAgICB9XG4gICAgY29uc3QgZGVsZXRlUHJvbWlzZXMgPSBbXTtcbiAgICBjb25zdCBpbnNlcnRlZEluZGV4ZXMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhzdWJtaXR0ZWRJbmRleGVzKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgZmllbGQgPSBzdWJtaXR0ZWRJbmRleGVzW25hbWVdO1xuICAgICAgaWYgKGV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wICE9PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICBgSW5kZXggJHtuYW1lfSBleGlzdHMsIGNhbm5vdCB1cGRhdGUuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKCFleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgYEluZGV4ICR7bmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIGNvbnN0IHByb21pc2UgPSB0aGlzLmRyb3BJbmRleChjbGFzc05hbWUsIG5hbWUpO1xuICAgICAgICBkZWxldGVQcm9taXNlcy5wdXNoKHByb21pc2UpO1xuICAgICAgICBkZWxldGUgZXhpc3RpbmdJbmRleGVzW25hbWVdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgT2JqZWN0LmtleXMoZmllbGQpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICBpZiAoIWZpZWxkcy5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgICAgIGBGaWVsZCAke2tleX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBhZGQgaW5kZXguYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBleGlzdGluZ0luZGV4ZXNbbmFtZV0gPSBmaWVsZDtcbiAgICAgICAgaW5zZXJ0ZWRJbmRleGVzLnB1c2goe1xuICAgICAgICAgIGtleTogZmllbGQsXG4gICAgICAgICAgbmFtZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgbGV0IGluc2VydFByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBpZiAoaW5zZXJ0ZWRJbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGluc2VydFByb21pc2UgPSB0aGlzLmNyZWF0ZUluZGV4ZXMoY2xhc3NOYW1lLCBpbnNlcnRlZEluZGV4ZXMpO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoZGVsZXRlUHJvbWlzZXMpXG4gICAgICAudGhlbigoKSA9PiBpbnNlcnRQcm9taXNlKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHtcbiAgICAgICAgICAkc2V0OiB7ICdfbWV0YWRhdGEuaW5kZXhlcyc6IGV4aXN0aW5nSW5kZXhlcyB9LFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgc2V0SW5kZXhlc0Zyb21Nb25nbyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLmdldEluZGV4ZXMoY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oaW5kZXhlcyA9PiB7XG4gICAgICAgIGluZGV4ZXMgPSBpbmRleGVzLnJlZHVjZSgob2JqLCBpbmRleCkgPT4ge1xuICAgICAgICAgIGlmIChpbmRleC5rZXkuX2Z0cykge1xuICAgICAgICAgICAgZGVsZXRlIGluZGV4LmtleS5fZnRzO1xuICAgICAgICAgICAgZGVsZXRlIGluZGV4LmtleS5fZnRzeDtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gaW5kZXgud2VpZ2h0cykge1xuICAgICAgICAgICAgICBpbmRleC5rZXlbZmllbGRdID0gJ3RleHQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBvYmpbaW5kZXgubmFtZV0gPSBpbmRleC5rZXk7XG4gICAgICAgICAgcmV0dXJuIG9iajtcbiAgICAgICAgfSwge30pO1xuICAgICAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICAgIHNjaGVtYUNvbGxlY3Rpb24udXBkYXRlU2NoZW1hKGNsYXNzTmFtZSwge1xuICAgICAgICAgICAgJHNldDogeyAnX21ldGFkYXRhLmluZGV4ZXMnOiBpbmRleGVzIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIElnbm9yZSBpZiBjb2xsZWN0aW9uIG5vdCBmb3VuZFxuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29PYmplY3QgPSBtb25nb1NjaGVtYUZyb21GaWVsZHNBbmRDbGFzc05hbWVBbmRDTFAoXG4gICAgICBzY2hlbWEuZmllbGRzLFxuICAgICAgY2xhc3NOYW1lLFxuICAgICAgc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgIHNjaGVtYS5pbmRleGVzXG4gICAgKTtcbiAgICBtb25nb09iamVjdC5faWQgPSBjbGFzc05hbWU7XG4gICAgcmV0dXJuIHRoaXMuc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBzY2hlbWEuaW5kZXhlcyxcbiAgICAgIHt9LFxuICAgICAgc2NoZW1hLmZpZWxkc1xuICAgIClcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKSlcbiAgICAgIC50aGVuKHNjaGVtYUNvbGxlY3Rpb24gPT4gc2NoZW1hQ29sbGVjdGlvbi5pbnNlcnRTY2hlbWEobW9uZ29PYmplY3QpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgYWRkRmllbGRJZk5vdEV4aXN0cyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBmaWVsZE5hbWU6IHN0cmluZyxcbiAgICB0eXBlOiBhbnlcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIHRoaXMuX3NjaGVtYUNvbGxlY3Rpb24oKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLmFkZEZpZWxkSWZOb3RFeGlzdHMoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHR5cGUpXG4gICAgICApXG4gICAgICAudGhlbigoKSA9PiB0aGlzLmNyZWF0ZUluZGV4ZXNJZk5lZWRlZChjbGFzc05hbWUsIGZpZWxkTmFtZSwgdHlwZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBEcm9wcyBhIGNvbGxlY3Rpb24uIFJlc29sdmVzIHdpdGggdHJ1ZSBpZiBpdCB3YXMgYSBQYXJzZSBTY2hlbWEgKGVnLiBfVXNlciwgQ3VzdG9tLCBldGMuKVxuICAvLyBhbmQgcmVzb2x2ZXMgd2l0aCBmYWxzZSBpZiBpdCB3YXNuJ3QgKGVnLiBhIGpvaW4gdGFibGUpLiBSZWplY3RzIGlmIGRlbGV0aW9uIHdhcyBpbXBvc3NpYmxlLlxuICBkZWxldGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiAoXG4gICAgICB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uZHJvcCgpKVxuICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgIC8vICducyBub3QgZm91bmQnIG1lYW5zIGNvbGxlY3Rpb24gd2FzIGFscmVhZHkgZ29uZS4gSWdub3JlIGRlbGV0aW9uIGF0dGVtcHQuXG4gICAgICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgPT0gJ25zIG5vdCBmb3VuZCcpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0pXG4gICAgICAgIC8vIFdlJ3ZlIGRyb3BwZWQgdGhlIGNvbGxlY3Rpb24sIG5vdyByZW1vdmUgdGhlIF9TQ0hFTUEgZG9jdW1lbnRcbiAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgICAudGhlbihzY2hlbWFDb2xsZWN0aW9uID0+XG4gICAgICAgICAgc2NoZW1hQ29sbGVjdGlvbi5maW5kQW5kRGVsZXRlU2NoZW1hKGNsYXNzTmFtZSlcbiAgICAgICAgKVxuICAgICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSlcbiAgICApO1xuICB9XG5cbiAgZGVsZXRlQWxsQ2xhc3NlcyhmYXN0OiBib29sZWFuKSB7XG4gICAgcmV0dXJuIHN0b3JhZ2VBZGFwdGVyQWxsQ29sbGVjdGlvbnModGhpcykudGhlbihjb2xsZWN0aW9ucyA9PlxuICAgICAgUHJvbWlzZS5hbGwoXG4gICAgICAgIGNvbGxlY3Rpb25zLm1hcChjb2xsZWN0aW9uID0+XG4gICAgICAgICAgZmFzdCA/IGNvbGxlY3Rpb24uZGVsZXRlTWFueSh7fSkgOiBjb2xsZWN0aW9uLmRyb3AoKVxuICAgICAgICApXG4gICAgICApXG4gICAgKTtcbiAgfVxuXG4gIC8vIFJlbW92ZSB0aGUgY29sdW1uIGFuZCBhbGwgdGhlIGRhdGEuIEZvciBSZWxhdGlvbnMsIHRoZSBfSm9pbiBjb2xsZWN0aW9uIGlzIGhhbmRsZWRcbiAgLy8gc3BlY2lhbGx5LCB0aGlzIGZ1bmN0aW9uIGRvZXMgbm90IGRlbGV0ZSBfSm9pbiBjb2x1bW5zLiBJdCBzaG91bGQsIGhvd2V2ZXIsIGluZGljYXRlXG4gIC8vIHRoYXQgdGhlIHJlbGF0aW9uIGZpZWxkcyBkb2VzIG5vdCBleGlzdCBhbnltb3JlLiBJbiBtb25nbywgdGhpcyBtZWFucyByZW1vdmluZyBpdCBmcm9tXG4gIC8vIHRoZSBfU0NIRU1BIGNvbGxlY3Rpb24uICBUaGVyZSBzaG91bGQgYmUgbm8gYWN0dWFsIGRhdGEgaW4gdGhlIGNvbGxlY3Rpb24gdW5kZXIgdGhlIHNhbWUgbmFtZVxuICAvLyBhcyB0aGUgcmVsYXRpb24gY29sdW1uLCBzbyBpdCdzIGZpbmUgdG8gYXR0ZW1wdCB0byBkZWxldGUgaXQuIElmIHRoZSBmaWVsZHMgbGlzdGVkIHRvIGJlXG4gIC8vIGRlbGV0ZWQgZG8gbm90IGV4aXN0LCB0aGlzIGZ1bmN0aW9uIHNob3VsZCByZXR1cm4gc3VjY2Vzc2Z1bGx5IGFueXdheXMuIENoZWNraW5nIGZvclxuICAvLyBhdHRlbXB0cyB0byBkZWxldGUgbm9uLWV4aXN0ZW50IGZpZWxkcyBpcyB0aGUgcmVzcG9uc2liaWxpdHkgb2YgUGFyc2UgU2VydmVyLlxuXG4gIC8vIFBvaW50ZXIgZmllbGQgbmFtZXMgYXJlIHBhc3NlZCBmb3IgbGVnYWN5IHJlYXNvbnM6IHRoZSBvcmlnaW5hbCBtb25nb1xuICAvLyBmb3JtYXQgc3RvcmVkIHBvaW50ZXIgZmllbGQgbmFtZXMgZGlmZmVyZW50bHkgaW4gdGhlIGRhdGFiYXNlLCBhbmQgdGhlcmVmb3JlXG4gIC8vIG5lZWRlZCB0byBrbm93IHRoZSB0eXBlIG9mIHRoZSBmaWVsZCBiZWZvcmUgaXQgY291bGQgZGVsZXRlIGl0LiBGdXR1cmUgZGF0YWJhc2VcbiAgLy8gYWRhcHRlcnMgc2hvdWxkIGlnbm9yZSB0aGUgcG9pbnRlckZpZWxkTmFtZXMgYXJndW1lbnQuIEFsbCB0aGUgZmllbGQgbmFtZXMgYXJlIGluXG4gIC8vIGZpZWxkTmFtZXMsIHRoZXkgc2hvdyB1cCBhZGRpdGlvbmFsbHkgaW4gdGhlIHBvaW50ZXJGaWVsZE5hbWVzIGRhdGFiYXNlIGZvciB1c2VcbiAgLy8gYnkgdGhlIG1vbmdvIGFkYXB0ZXIsIHdoaWNoIGRlYWxzIHdpdGggdGhlIGxlZ2FjeSBtb25nbyBmb3JtYXQuXG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBub3Qgb2JsaWdhdGVkIHRvIGRlbGV0ZSBmaWVsZHMgYXRvbWljYWxseS4gSXQgaXMgZ2l2ZW4gdGhlIGZpZWxkXG4gIC8vIG5hbWVzIGluIGEgbGlzdCBzbyB0aGF0IGRhdGFiYXNlcyB0aGF0IGFyZSBjYXBhYmxlIG9mIGRlbGV0aW5nIGZpZWxkcyBhdG9taWNhbGx5XG4gIC8vIG1heSBkbyBzby5cblxuICAvLyBSZXR1cm5zIGEgUHJvbWlzZS5cbiAgZGVsZXRlRmllbGRzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIGZpZWxkTmFtZXM6IHN0cmluZ1tdKSB7XG4gICAgY29uc3QgbW9uZ29Gb3JtYXROYW1lcyA9IGZpZWxkTmFtZXMubWFwKGZpZWxkTmFtZSA9PiB7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICByZXR1cm4gYF9wXyR7ZmllbGROYW1lfWA7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gZmllbGROYW1lO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNvbnN0IGNvbGxlY3Rpb25VcGRhdGUgPSB7ICR1bnNldDoge30gfTtcbiAgICBtb25nb0Zvcm1hdE5hbWVzLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBjb2xsZWN0aW9uVXBkYXRlWyckdW5zZXQnXVtuYW1lXSA9IG51bGw7XG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2hlbWFVcGRhdGUgPSB7ICR1bnNldDoge30gfTtcbiAgICBmaWVsZE5hbWVzLmZvckVhY2gobmFtZSA9PiB7XG4gICAgICBzY2hlbWFVcGRhdGVbJyR1bnNldCddW25hbWVdID0gbnVsbDtcbiAgICB9KTtcblxuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwZGF0ZU1hbnkoe30sIGNvbGxlY3Rpb25VcGRhdGUpKVxuICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpKVxuICAgICAgLnRoZW4oc2NoZW1hQ29sbGVjdGlvbiA9PlxuICAgICAgICBzY2hlbWFDb2xsZWN0aW9uLnVwZGF0ZVNjaGVtYShjbGFzc05hbWUsIHNjaGVtYVVwZGF0ZSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIGFsbCBzY2hlbWFzIGtub3duIHRvIHRoaXMgYWRhcHRlciwgaW4gUGFyc2UgZm9ybWF0LiBJbiBjYXNlIHRoZVxuICAvLyBzY2hlbWFzIGNhbm5vdCBiZSByZXRyaWV2ZWQsIHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVqZWN0cy4gUmVxdWlyZW1lbnRzIGZvciB0aGVcbiAgLy8gcmVqZWN0aW9uIHJlYXNvbiBhcmUgVEJELlxuICBnZXRBbGxDbGFzc2VzKCk6IFByb21pc2U8U3RvcmFnZUNsYXNzW10+IHtcbiAgICByZXR1cm4gdGhpcy5fc2NoZW1hQ29sbGVjdGlvbigpXG4gICAgICAudGhlbihzY2hlbWFzQ29sbGVjdGlvbiA9PlxuICAgICAgICBzY2hlbWFzQ29sbGVjdGlvbi5fZmV0Y2hBbGxTY2hlbWFzRnJvbV9TQ0hFTUEoKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgdGhlIHNjaGVtYSB3aXRoIHRoZSBnaXZlbiBuYW1lLCBpbiBQYXJzZSBmb3JtYXQuIElmXG4gIC8vIHRoaXMgYWRhcHRlciBkb2Vzbid0IGtub3cgYWJvdXQgdGhlIHNjaGVtYSwgcmV0dXJuIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMgd2l0aFxuICAvLyB1bmRlZmluZWQgYXMgdGhlIHJlYXNvbi5cbiAgZ2V0Q2xhc3MoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPFN0b3JhZ2VDbGFzcz4ge1xuICAgIHJldHVybiB0aGlzLl9zY2hlbWFDb2xsZWN0aW9uKClcbiAgICAgIC50aGVuKHNjaGVtYXNDb2xsZWN0aW9uID0+XG4gICAgICAgIHNjaGVtYXNDb2xsZWN0aW9uLl9mZXRjaE9uZVNjaGVtYUZyb21fU0NIRU1BKGNsYXNzTmFtZSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFRPRE86IEFzIHlldCBub3QgcGFydGljdWxhcmx5IHdlbGwgc3BlY2lmaWVkLiBDcmVhdGVzIGFuIG9iamVjdC4gTWF5YmUgc2hvdWxkbid0IGV2ZW4gbmVlZCB0aGUgc2NoZW1hLFxuICAvLyBhbmQgc2hvdWxkIGluZmVyIGZyb20gdGhlIHR5cGUuIE9yIG1heWJlIGRvZXMgbmVlZCB0aGUgc2NoZW1hIGZvciB2YWxpZGF0aW9ucy4gT3IgbWF5YmUgbmVlZHNcbiAgLy8gdGhlIHNjaGVtYSBvbmx5IGZvciB0aGUgbGVnYWN5IG1vbmdvIGZvcm1hdC4gV2UnbGwgZmlndXJlIHRoYXQgb3V0IGxhdGVyLlxuICBjcmVhdGVPYmplY3QoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgb2JqZWN0OiBhbnkpIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29PYmplY3QgPSBwYXJzZU9iamVjdFRvTW9uZ29PYmplY3RGb3JDcmVhdGUoXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBvYmplY3QsXG4gICAgICBzY2hlbWFcbiAgICApO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLmluc2VydE9uZShtb25nb09iamVjdCkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICAvLyBEdXBsaWNhdGUgdmFsdWVcbiAgICAgICAgICBjb25zdCBlcnIgPSBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICApO1xuICAgICAgICAgIGVyci51bmRlcmx5aW5nRXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICBpZiAoZXJyb3IubWVzc2FnZSkge1xuICAgICAgICAgICAgY29uc3QgbWF0Y2hlcyA9IGVycm9yLm1lc3NhZ2UubWF0Y2goXG4gICAgICAgICAgICAgIC9pbmRleDpbXFxzYS16QS1aMC05X1xcLVxcLl0rXFwkPyhbYS16QS1aXy1dKylfMS9cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAobWF0Y2hlcyAmJiBBcnJheS5pc0FycmF5KG1hdGNoZXMpKSB7XG4gICAgICAgICAgICAgIGVyci51c2VySW5mbyA9IHsgZHVwbGljYXRlZF9maWVsZDogbWF0Y2hlc1sxXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gUmVtb3ZlIGFsbCBvYmplY3RzIHRoYXQgbWF0Y2ggdGhlIGdpdmVuIFBhcnNlIFF1ZXJ5LlxuICAvLyBJZiBubyBvYmplY3RzIG1hdGNoLCByZWplY3Qgd2l0aCBPQkpFQ1RfTk9UX0ZPVU5ELiBJZiBvYmplY3RzIGFyZSBmb3VuZCBhbmQgZGVsZXRlZCwgcmVzb2x2ZSB3aXRoIHVuZGVmaW5lZC5cbiAgLy8gSWYgdGhlcmUgaXMgc29tZSBvdGhlciBlcnJvciwgcmVqZWN0IHdpdGggSU5URVJOQUxfU0VSVkVSX0VSUk9SLlxuICBkZWxldGVPYmplY3RzQnlRdWVyeShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IHtcbiAgICAgICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgICAgIHJldHVybiBjb2xsZWN0aW9uLmRlbGV0ZU1hbnkobW9uZ29XaGVyZSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpXG4gICAgICAudGhlbihcbiAgICAgICAgKHsgcmVzdWx0IH0pID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0Lm4gPT09IDApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQuJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICB9LFxuICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICAgJ0RhdGFiYXNlIGFkYXB0ZXIgZXJyb3InXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgKTtcbiAgfVxuXG4gIC8vIEFwcGx5IHRoZSB1cGRhdGUgdG8gYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIHVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55XG4gICkge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1VwZGF0ZSA9IHRyYW5zZm9ybVVwZGF0ZShjbGFzc05hbWUsIHVwZGF0ZSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi51cGRhdGVNYW55KG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIEF0b21pY2FsbHkgZmluZHMgYW5kIHVwZGF0ZXMgYW4gb2JqZWN0IGJhc2VkIG9uIHF1ZXJ5LlxuICAvLyBSZXR1cm4gdmFsdWUgbm90IGN1cnJlbnRseSB3ZWxsIHNwZWNpZmllZC5cbiAgZmluZE9uZUFuZFVwZGF0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueVxuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29VcGRhdGUgPSB0cmFuc2Zvcm1VcGRhdGUoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgY29uc3QgbW9uZ29XaGVyZSA9IHRyYW5zZm9ybVdoZXJlKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSk7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+XG4gICAgICAgIGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5maW5kT25lQW5kVXBkYXRlKG1vbmdvV2hlcmUsIG1vbmdvVXBkYXRlLCB7XG4gICAgICAgICAgcmV0dXJuT3JpZ2luYWw6IGZhbHNlLFxuICAgICAgICB9KVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIHJlc3VsdC52YWx1ZSwgc2NoZW1hKSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSAxMTAwMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgLy8gSG9wZWZ1bGx5IHdlIGNhbiBnZXQgcmlkIG9mIHRoaXMuIEl0J3Mgb25seSB1c2VkIGZvciBjb25maWcgYW5kIGhvb2tzLlxuICB1cHNlcnRPbmVPYmplY3QoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgc2NoZW1hOiBTY2hlbWFUeXBlLFxuICAgIHF1ZXJ5OiBRdWVyeVR5cGUsXG4gICAgdXBkYXRlOiBhbnlcbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvVXBkYXRlID0gdHJhbnNmb3JtVXBkYXRlKGNsYXNzTmFtZSwgdXBkYXRlLCBzY2hlbWEpO1xuICAgIGNvbnN0IG1vbmdvV2hlcmUgPSB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpO1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLnVwc2VydE9uZShtb25nb1doZXJlLCBtb25nb1VwZGF0ZSkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBFeGVjdXRlcyBhIGZpbmQuIEFjY2VwdHM6IGNsYXNzTmFtZSwgcXVlcnkgaW4gUGFyc2UgZm9ybWF0LCBhbmQgeyBza2lwLCBsaW1pdCwgc29ydCB9LlxuICBmaW5kKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHsgc2tpcCwgbGltaXQsIHNvcnQsIGtleXMsIHJlYWRQcmVmZXJlbmNlIH06IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPGFueT4ge1xuICAgIHNjaGVtYSA9IGNvbnZlcnRQYXJzZVNjaGVtYVRvTW9uZ29TY2hlbWEoc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1doZXJlID0gdHJhbnNmb3JtV2hlcmUoY2xhc3NOYW1lLCBxdWVyeSwgc2NoZW1hKTtcbiAgICBjb25zdCBtb25nb1NvcnQgPSBfLm1hcEtleXMoc29ydCwgKHZhbHVlLCBmaWVsZE5hbWUpID0+XG4gICAgICB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSlcbiAgICApO1xuICAgIGNvbnN0IG1vbmdvS2V5cyA9IF8ucmVkdWNlKFxuICAgICAga2V5cyxcbiAgICAgIChtZW1vLCBrZXkpID0+IHtcbiAgICAgICAgaWYgKGtleSA9PT0gJ0FDTCcpIHtcbiAgICAgICAgICBtZW1vWydfcnBlcm0nXSA9IDE7XG4gICAgICAgICAgbWVtb1snX3dwZXJtJ10gPSAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG1lbW9bdHJhbnNmb3JtS2V5KGNsYXNzTmFtZSwga2V5LCBzY2hlbWEpXSA9IDE7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9LFxuICAgICAge31cbiAgICApO1xuXG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVUZXh0SW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PlxuICAgICAgICBjb2xsZWN0aW9uLmZpbmQobW9uZ29XaGVyZSwge1xuICAgICAgICAgIHNraXAsXG4gICAgICAgICAgbGltaXQsXG4gICAgICAgICAgc29ydDogbW9uZ29Tb3J0LFxuICAgICAgICAgIGtleXM6IG1vbmdvS2V5cyxcbiAgICAgICAgICBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyxcbiAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC50aGVuKG9iamVjdHMgPT5cbiAgICAgICAgb2JqZWN0cy5tYXAob2JqZWN0ID0+XG4gICAgICAgICAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIENyZWF0ZSBhIHVuaXF1ZSBpbmRleC4gVW5pcXVlIGluZGV4ZXMgb24gbnVsbGFibGUgZmllbGRzIGFyZSBub3QgYWxsb3dlZC4gU2luY2Ugd2UgZG9uJ3RcbiAgLy8gY3VycmVudGx5IGtub3cgd2hpY2ggZmllbGRzIGFyZSBudWxsYWJsZSBhbmQgd2hpY2ggYXJlbid0LCB3ZSBpZ25vcmUgdGhhdCBjcml0ZXJpYS5cbiAgLy8gQXMgc3VjaCwgd2Ugc2hvdWxkbid0IGV4cG9zZSB0aGlzIGZ1bmN0aW9uIHRvIHVzZXJzIG9mIHBhcnNlIHVudGlsIHdlIGhhdmUgYW4gb3V0LW9mLWJhbmRcbiAgLy8gV2F5IG9mIGRldGVybWluaW5nIGlmIGEgZmllbGQgaXMgbnVsbGFibGUuIFVuZGVmaW5lZCBkb2Vzbid0IGNvdW50IGFnYWluc3QgdW5pcXVlbmVzcyxcbiAgLy8gd2hpY2ggaXMgd2h5IHdlIHVzZSBzcGFyc2UgaW5kZXhlcy5cbiAgZW5zdXJlVW5pcXVlbmVzcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgZmllbGROYW1lczogc3RyaW5nW11cbiAgKSB7XG4gICAgc2NoZW1hID0gY29udmVydFBhcnNlU2NoZW1hVG9Nb25nb1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGluZGV4Q3JlYXRpb25SZXF1ZXN0ID0ge307XG4gICAgY29uc3QgbW9uZ29GaWVsZE5hbWVzID0gZmllbGROYW1lcy5tYXAoZmllbGROYW1lID0+XG4gICAgICB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSlcbiAgICApO1xuICAgIG1vbmdvRmllbGROYW1lcy5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICBpbmRleENyZWF0aW9uUmVxdWVzdFtmaWVsZE5hbWVdID0gMTtcbiAgICB9KTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5fZW5zdXJlU3BhcnNlVW5pcXVlSW5kZXhJbkJhY2tncm91bmQoaW5kZXhDcmVhdGlvblJlcXVlc3QpXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gMTEwMDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnVHJpZWQgdG8gZW5zdXJlIGZpZWxkIHVuaXF1ZW5lc3MgZm9yIGEgY2xhc3MgdGhhdCBhbHJlYWR5IGhhcyBkdXBsaWNhdGVzLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFVzZWQgaW4gdGVzdHNcbiAgX3Jhd0ZpbmQoY2xhc3NOYW1lOiBzdHJpbmcsIHF1ZXJ5OiBRdWVyeVR5cGUpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5maW5kKHF1ZXJ5LCB7XG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICAvLyBFeGVjdXRlcyBhIGNvdW50LlxuICBjb3VudChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICByZWFkUHJlZmVyZW5jZTogP3N0cmluZ1xuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5jb3VudCh0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEsIHRydWUpLCB7XG4gICAgICAgICAgbWF4VGltZU1TOiB0aGlzLl9tYXhUaW1lTVMsXG4gICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgIH0pXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBkaXN0aW5jdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICBmaWVsZE5hbWU6IHN0cmluZ1xuICApIHtcbiAgICBzY2hlbWEgPSBjb252ZXJ0UGFyc2VTY2hlbWFUb01vbmdvU2NoZW1hKHNjaGVtYSk7XG4gICAgY29uc3QgaXNQb2ludGVyRmllbGQgPVxuICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUG9pbnRlcic7XG4gICAgY29uc3QgdHJhbnNmb3JtRmllbGQgPSB0cmFuc2Zvcm1LZXkoY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHNjaGVtYSk7XG5cbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5kaXN0aW5jdChcbiAgICAgICAgICB0cmFuc2Zvcm1GaWVsZCxcbiAgICAgICAgICB0cmFuc2Zvcm1XaGVyZShjbGFzc05hbWUsIHF1ZXJ5LCBzY2hlbWEpXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgIC50aGVuKG9iamVjdHMgPT4ge1xuICAgICAgICBvYmplY3RzID0gb2JqZWN0cy5maWx0ZXIob2JqID0+IG9iaiAhPSBudWxsKTtcbiAgICAgICAgcmV0dXJuIG9iamVjdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgaWYgKGlzUG9pbnRlckZpZWxkKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhbnNmb3JtUG9pbnRlclN0cmluZyhzY2hlbWEsIGZpZWxkTmFtZSwgb2JqZWN0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG1vbmdvT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgfSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgYWdncmVnYXRlKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogYW55LFxuICAgIHBpcGVsaW5lOiBhbnksXG4gICAgcmVhZFByZWZlcmVuY2U6ID9zdHJpbmdcbiAgKSB7XG4gICAgbGV0IGlzUG9pbnRlckZpZWxkID0gZmFsc2U7XG4gICAgcGlwZWxpbmUgPSBwaXBlbGluZS5tYXAoc3RhZ2UgPT4ge1xuICAgICAgaWYgKHN0YWdlLiRncm91cCkge1xuICAgICAgICBzdGFnZS4kZ3JvdXAgPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWEsIHN0YWdlLiRncm91cCk7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBzdGFnZS4kZ3JvdXAuX2lkICYmXG4gICAgICAgICAgdHlwZW9mIHN0YWdlLiRncm91cC5faWQgPT09ICdzdHJpbmcnICYmXG4gICAgICAgICAgc3RhZ2UuJGdyb3VwLl9pZC5pbmRleE9mKCckX3BfJykgPj0gMFxuICAgICAgICApIHtcbiAgICAgICAgICBpc1BvaW50ZXJGaWVsZCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kbWF0Y2gpIHtcbiAgICAgICAgc3RhZ2UuJG1hdGNoID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgc3RhZ2UuJG1hdGNoKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kcHJvamVjdCkge1xuICAgICAgICBzdGFnZS4kcHJvamVjdCA9IHRoaXMuX3BhcnNlQWdncmVnYXRlUHJvamVjdEFyZ3MoXG4gICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgIHN0YWdlLiRwcm9qZWN0XG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gc3RhZ2U7XG4gICAgfSk7XG4gICAgcmVhZFByZWZlcmVuY2UgPSB0aGlzLl9wYXJzZVJlYWRQcmVmZXJlbmNlKHJlYWRQcmVmZXJlbmNlKTtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT5cbiAgICAgICAgY29sbGVjdGlvbi5hZ2dyZWdhdGUocGlwZWxpbmUsIHtcbiAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICBtYXhUaW1lTVM6IHRoaXMuX21heFRpbWVNUyxcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICByZXN1bHRzLmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0Lmhhc093blByb3BlcnR5KCdfaWQnKSkge1xuICAgICAgICAgICAgaWYgKGlzUG9pbnRlckZpZWxkICYmIHJlc3VsdC5faWQpIHtcbiAgICAgICAgICAgICAgcmVzdWx0Ll9pZCA9IHJlc3VsdC5faWQuc3BsaXQoJyQnKVsxXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChyZXN1bHQuX2lkID09IG51bGwgfHwgXy5pc0VtcHR5KHJlc3VsdC5faWQpKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5faWQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVzdWx0Lm9iamVjdElkID0gcmVzdWx0Ll9pZDtcbiAgICAgICAgICAgIGRlbGV0ZSByZXN1bHQuX2lkO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiByZXN1bHRzO1xuICAgICAgfSlcbiAgICAgIC50aGVuKG9iamVjdHMgPT5cbiAgICAgICAgb2JqZWN0cy5tYXAob2JqZWN0ID0+XG4gICAgICAgICAgbW9uZ29PYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpXG4gICAgICAgIClcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gd2lsbCByZWN1cnNpdmVseSB0cmF2ZXJzZSB0aGUgcGlwZWxpbmUgYW5kIGNvbnZlcnQgYW55IFBvaW50ZXIgb3IgRGF0ZSBjb2x1bW5zLlxuICAvLyBJZiB3ZSBkZXRlY3QgYSBwb2ludGVyIGNvbHVtbiB3ZSB3aWxsIHJlbmFtZSB0aGUgY29sdW1uIGJlaW5nIHF1ZXJpZWQgZm9yIHRvIG1hdGNoIHRoZSBjb2x1bW5cbiAgLy8gaW4gdGhlIGRhdGFiYXNlLiBXZSBhbHNvIG1vZGlmeSB0aGUgdmFsdWUgdG8gd2hhdCB3ZSBleHBlY3QgdGhlIHZhbHVlIHRvIGJlIGluIHRoZSBkYXRhYmFzZVxuICAvLyBhcyB3ZWxsLlxuICAvLyBGb3IgZGF0ZXMsIHRoZSBkcml2ZXIgZXhwZWN0cyBhIERhdGUgb2JqZWN0LCBidXQgd2UgaGF2ZSBhIHN0cmluZyBjb21pbmcgaW4uIFNvIHdlJ2xsIGNvbnZlcnRcbiAgLy8gdGhlIHN0cmluZyB0byBhIERhdGUgc28gdGhlIGRyaXZlciBjYW4gcGVyZm9ybSB0aGUgbmVjZXNzYXJ5IGNvbXBhcmlzb24uXG4gIC8vXG4gIC8vIFRoZSBnb2FsIG9mIHRoaXMgbWV0aG9kIGlzIHRvIGxvb2sgZm9yIHRoZSBcImxlYXZlc1wiIG9mIHRoZSBwaXBlbGluZSBhbmQgZGV0ZXJtaW5lIGlmIGl0IG5lZWRzXG4gIC8vIHRvIGJlIGNvbnZlcnRlZC4gVGhlIHBpcGVsaW5lIGNhbiBoYXZlIGEgZmV3IGRpZmZlcmVudCBmb3Jtcy4gRm9yIG1vcmUgZGV0YWlscywgc2VlOlxuICAvLyAgICAgaHR0cHM6Ly9kb2NzLm1vbmdvZGIuY29tL21hbnVhbC9yZWZlcmVuY2Uvb3BlcmF0b3IvYWdncmVnYXRpb24vXG4gIC8vXG4gIC8vIElmIHRoZSBwaXBlbGluZSBpcyBhbiBhcnJheSwgaXQgbWVhbnMgd2UgYXJlIHByb2JhYmx5IHBhcnNpbmcgYW4gJyRhbmQnIG9yICckb3InIG9wZXJhdG9yLiBJblxuICAvLyB0aGF0IGNhc2Ugd2UgbmVlZCB0byBsb29wIHRocm91Z2ggYWxsIG9mIGl0J3MgY2hpbGRyZW4gdG8gZmluZCB0aGUgY29sdW1ucyBiZWluZyBvcGVyYXRlZCBvbi5cbiAgLy8gSWYgdGhlIHBpcGVsaW5lIGlzIGFuIG9iamVjdCwgdGhlbiB3ZSdsbCBsb29wIHRocm91Z2ggdGhlIGtleXMgY2hlY2tpbmcgdG8gc2VlIGlmIHRoZSBrZXkgbmFtZVxuICAvLyBtYXRjaGVzIG9uZSBvZiB0aGUgc2NoZW1hIGNvbHVtbnMuIElmIGl0IGRvZXMgbWF0Y2ggYSBjb2x1bW4gYW5kIHRoZSBjb2x1bW4gaXMgYSBQb2ludGVyIG9yXG4gIC8vIGEgRGF0ZSwgdGhlbiB3ZSdsbCBjb252ZXJ0IHRoZSB2YWx1ZSBhcyBkZXNjcmliZWQgYWJvdmUuXG4gIC8vXG4gIC8vIEFzIG11Y2ggYXMgSSBoYXRlIHJlY3Vyc2lvbi4uLnRoaXMgc2VlbWVkIGxpa2UgYSBnb29kIGZpdCBmb3IgaXQuIFdlJ3JlIGVzc2VudGlhbGx5IHRyYXZlcnNpbmdcbiAgLy8gZG93biBhIHRyZWUgdG8gZmluZCBhIFwibGVhZiBub2RlXCIgYW5kIGNoZWNraW5nIHRvIHNlZSBpZiBpdCBuZWVkcyB0byBiZSBjb252ZXJ0ZWQuXG4gIF9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hOiBhbnksIHBpcGVsaW5lOiBhbnkpOiBhbnkge1xuICAgIGlmIChBcnJheS5pc0FycmF5KHBpcGVsaW5lKSkge1xuICAgICAgcmV0dXJuIHBpcGVsaW5lLm1hcCh2YWx1ZSA9PiB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3Moc2NoZW1hLCB2YWx1ZSkpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHBpcGVsaW5lID09PSAnb2JqZWN0Jykge1xuICAgICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gcGlwZWxpbmUpIHtcbiAgICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICAgIGlmICh0eXBlb2YgcGlwZWxpbmVbZmllbGRdID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgLy8gUGFzcyBvYmplY3RzIGRvd24gdG8gTW9uZ29EQi4uLnRoaXMgaXMgbW9yZSB0aGFuIGxpa2VseSBhbiAkZXhpc3RzIG9wZXJhdG9yLlxuICAgICAgICAgICAgcmV0dXJuVmFsdWVbYF9wXyR7ZmllbGR9YF0gPSBwaXBlbGluZVtmaWVsZF07XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVyblZhbHVlW2BfcF8ke2ZpZWxkfWBdID0gYCR7c2NoZW1hLmZpZWxkc1tmaWVsZF0udGFyZ2V0Q2xhc3N9JCR7XG4gICAgICAgICAgICAgIHBpcGVsaW5lW2ZpZWxkXVxuICAgICAgICAgICAgfWA7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGRdICYmXG4gICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ0RhdGUnXG4gICAgICAgICkge1xuICAgICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX2NvbnZlcnRUb0RhdGUocGlwZWxpbmVbZmllbGRdKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVtmaWVsZF0gPSB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUFyZ3MoXG4gICAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgICBwaXBlbGluZVtmaWVsZF1cbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpZWxkID09PSAnb2JqZWN0SWQnKSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbJ19pZCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT09ICdjcmVhdGVkQXQnKSB7XG4gICAgICAgICAgcmV0dXJuVmFsdWVbJ19jcmVhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ3VwZGF0ZWRBdCcpIHtcbiAgICAgICAgICByZXR1cm5WYWx1ZVsnX3VwZGF0ZWRfYXQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gICAgfVxuICAgIHJldHVybiBwaXBlbGluZTtcbiAgfVxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgc2xpZ2h0bHkgZGlmZmVyZW50IHRoYW4gdGhlIG9uZSBhYm92ZS4gUmF0aGVyIHRoYW4gdHJ5aW5nIHRvIGNvbWJpbmUgdGhlc2VcbiAgLy8gdHdvIGZ1bmN0aW9ucyBhbmQgbWFraW5nIHRoZSBjb2RlIGV2ZW4gaGFyZGVyIHRvIHVuZGVyc3RhbmQsIEkgZGVjaWRlZCB0byBzcGxpdCBpdCB1cC4gVGhlXG4gIC8vIGRpZmZlcmVuY2Ugd2l0aCB0aGlzIGZ1bmN0aW9uIGlzIHdlIGFyZSBub3QgdHJhbnNmb3JtaW5nIHRoZSB2YWx1ZXMsIG9ubHkgdGhlIGtleXMgb2YgdGhlXG4gIC8vIHBpcGVsaW5lLlxuICBfcGFyc2VBZ2dyZWdhdGVQcm9qZWN0QXJncyhzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSk6IGFueSB7XG4gICAgY29uc3QgcmV0dXJuVmFsdWUgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHBpcGVsaW5lKSB7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgIHJldHVyblZhbHVlW2BfcF8ke2ZpZWxkfWBdID0gcGlwZWxpbmVbZmllbGRdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fcGFyc2VBZ2dyZWdhdGVBcmdzKHNjaGVtYSwgcGlwZWxpbmVbZmllbGRdKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGZpZWxkID09PSAnb2JqZWN0SWQnKSB7XG4gICAgICAgIHJldHVyblZhbHVlWydfaWQnXSA9IHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgICAgZGVsZXRlIHJldHVyblZhbHVlW2ZpZWxkXTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT09ICdjcmVhdGVkQXQnKSB7XG4gICAgICAgIHJldHVyblZhbHVlWydfY3JlYXRlZF9hdCddID0gcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgICBkZWxldGUgcmV0dXJuVmFsdWVbZmllbGRdO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gJ3VwZGF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuVmFsdWVbJ191cGRhdGVkX2F0J10gPSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICAgIGRlbGV0ZSByZXR1cm5WYWx1ZVtmaWVsZF07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgfVxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgc2xpZ2h0bHkgZGlmZmVyZW50IHRoYW4gdGhlIHR3byBhYm92ZS4gTW9uZ29EQiAkZ3JvdXAgYWdncmVnYXRlIGxvb2tzIGxpa2U6XG4gIC8vICAgICB7ICRncm91cDogeyBfaWQ6IDxleHByZXNzaW9uPiwgPGZpZWxkMT46IHsgPGFjY3VtdWxhdG9yMT4gOiA8ZXhwcmVzc2lvbjE+IH0sIC4uLiB9IH1cbiAgLy8gVGhlIDxleHByZXNzaW9uPiBjb3VsZCBiZSBhIGNvbHVtbiBuYW1lLCBwcmVmaXhlZCB3aXRoIHRoZSAnJCcgY2hhcmFjdGVyLiBXZSdsbCBsb29rIGZvclxuICAvLyB0aGVzZSA8ZXhwcmVzc2lvbj4gYW5kIGNoZWNrIHRvIHNlZSBpZiBpdCBpcyBhICdQb2ludGVyJyBvciBpZiBpdCdzIG9uZSBvZiBjcmVhdGVkQXQsXG4gIC8vIHVwZGF0ZWRBdCBvciBvYmplY3RJZCBhbmQgY2hhbmdlIGl0IGFjY29yZGluZ2x5LlxuICBfcGFyc2VBZ2dyZWdhdGVHcm91cEFyZ3Moc2NoZW1hOiBhbnksIHBpcGVsaW5lOiBhbnkpOiBhbnkge1xuICAgIGlmIChBcnJheS5pc0FycmF5KHBpcGVsaW5lKSkge1xuICAgICAgcmV0dXJuIHBpcGVsaW5lLm1hcCh2YWx1ZSA9PlxuICAgICAgICB0aGlzLl9wYXJzZUFnZ3JlZ2F0ZUdyb3VwQXJncyhzY2hlbWEsIHZhbHVlKVxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBwaXBlbGluZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307XG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHBpcGVsaW5lKSB7XG4gICAgICAgIHJldHVyblZhbHVlW2ZpZWxkXSA9IHRoaXMuX3BhcnNlQWdncmVnYXRlR3JvdXBBcmdzKFxuICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICBwaXBlbGluZVtmaWVsZF1cbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXR1cm5WYWx1ZTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBwaXBlbGluZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIGNvbnN0IGZpZWxkID0gcGlwZWxpbmUuc3Vic3RyaW5nKDEpO1xuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGRdICYmIHNjaGVtYS5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICByZXR1cm4gYCRfcF8ke2ZpZWxkfWA7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkID09ICdjcmVhdGVkQXQnKSB7XG4gICAgICAgIHJldHVybiAnJF9jcmVhdGVkX2F0JztcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQgPT0gJ3VwZGF0ZWRBdCcpIHtcbiAgICAgICAgcmV0dXJuICckX3VwZGF0ZWRfYXQnO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcGlwZWxpbmU7XG4gIH1cblxuICAvLyBUaGlzIGZ1bmN0aW9uIHdpbGwgYXR0ZW1wdCB0byBjb252ZXJ0IHRoZSBwcm92aWRlZCB2YWx1ZSB0byBhIERhdGUgb2JqZWN0LiBTaW5jZSB0aGlzIGlzIHBhcnRcbiAgLy8gb2YgYW4gYWdncmVnYXRpb24gcGlwZWxpbmUsIHRoZSB2YWx1ZSBjYW4gZWl0aGVyIGJlIGEgc3RyaW5nIG9yIGl0IGNhbiBiZSBhbm90aGVyIG9iamVjdCB3aXRoXG4gIC8vIGFuIG9wZXJhdG9yIGluIGl0IChsaWtlICRndCwgJGx0LCBldGMpLiBCZWNhdXNlIG9mIHRoaXMgSSBmZWx0IGl0IHdhcyBlYXNpZXIgdG8gbWFrZSB0aGlzIGFcbiAgLy8gcmVjdXJzaXZlIG1ldGhvZCB0byB0cmF2ZXJzZSBkb3duIHRvIHRoZSBcImxlYWYgbm9kZVwiIHdoaWNoIGlzIGdvaW5nIHRvIGJlIHRoZSBzdHJpbmcuXG4gIF9jb252ZXJ0VG9EYXRlKHZhbHVlOiBhbnkpOiBhbnkge1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gbmV3IERhdGUodmFsdWUpO1xuICAgIH1cblxuICAgIGNvbnN0IHJldHVyblZhbHVlID0ge307XG4gICAgZm9yIChjb25zdCBmaWVsZCBpbiB2YWx1ZSkge1xuICAgICAgcmV0dXJuVmFsdWVbZmllbGRdID0gdGhpcy5fY29udmVydFRvRGF0ZSh2YWx1ZVtmaWVsZF0pO1xuICAgIH1cbiAgICByZXR1cm4gcmV0dXJuVmFsdWU7XG4gIH1cblxuICBfcGFyc2VSZWFkUHJlZmVyZW5jZShyZWFkUHJlZmVyZW5jZTogP3N0cmluZyk6ID9zdHJpbmcge1xuICAgIGlmIChyZWFkUHJlZmVyZW5jZSkge1xuICAgICAgcmVhZFByZWZlcmVuY2UgPSByZWFkUHJlZmVyZW5jZS50b1VwcGVyQ2FzZSgpO1xuICAgIH1cbiAgICBzd2l0Y2ggKHJlYWRQcmVmZXJlbmNlKSB7XG4gICAgICBjYXNlICdQUklNQVJZJzpcbiAgICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5QUklNQVJZO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1BSSU1BUllfUFJFRkVSUkVEJzpcbiAgICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5QUklNQVJZX1BSRUZFUlJFRDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdTRUNPTkRBUlknOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLlNFQ09OREFSWTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdTRUNPTkRBUllfUFJFRkVSUkVEJzpcbiAgICAgICAgcmVhZFByZWZlcmVuY2UgPSBSZWFkUHJlZmVyZW5jZS5TRUNPTkRBUllfUFJFRkVSUkVEO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ05FQVJFU1QnOlxuICAgICAgICByZWFkUHJlZmVyZW5jZSA9IFJlYWRQcmVmZXJlbmNlLk5FQVJFU1Q7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSB1bmRlZmluZWQ6XG4gICAgICBjYXNlIG51bGw6XG4gICAgICBjYXNlICcnOlxuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICdOb3Qgc3VwcG9ydGVkIHJlYWQgcHJlZmVyZW5jZS4nXG4gICAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiByZWFkUHJlZmVyZW5jZTtcbiAgfVxuXG4gIHBlcmZvcm1Jbml0aWFsaXphdGlvbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBjcmVhdGVJbmRleChjbGFzc05hbWU6IHN0cmluZywgaW5kZXg6IGFueSkge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXgoaW5kZXgpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgY3JlYXRlSW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZywgaW5kZXhlczogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5jcmVhdGVJbmRleGVzKGluZGV4ZXMpKVxuICAgICAgLmNhdGNoKGVyciA9PiB0aGlzLmhhbmRsZUVycm9yKGVycikpO1xuICB9XG5cbiAgY3JlYXRlSW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZTogc3RyaW5nLCBmaWVsZE5hbWU6IHN0cmluZywgdHlwZTogYW55KSB7XG4gICAgaWYgKHR5cGUgJiYgdHlwZS50eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgIGNvbnN0IGluZGV4ID0ge1xuICAgICAgICBbZmllbGROYW1lXTogJzJkc3BoZXJlJyxcbiAgICAgIH07XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVJbmRleChjbGFzc05hbWUsIGluZGV4KTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgY3JlYXRlVGV4dEluZGV4ZXNJZk5lZWRlZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHNjaGVtYTogYW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGZvciAoY29uc3QgZmllbGROYW1lIGluIHF1ZXJ5KSB7XG4gICAgICBpZiAoIXF1ZXJ5W2ZpZWxkTmFtZV0gfHwgIXF1ZXJ5W2ZpZWxkTmFtZV0uJHRleHQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBleGlzdGluZ0luZGV4ZXMgPSBzY2hlbWEuaW5kZXhlcztcbiAgICAgIGZvciAoY29uc3Qga2V5IGluIGV4aXN0aW5nSW5kZXhlcykge1xuICAgICAgICBjb25zdCBpbmRleCA9IGV4aXN0aW5nSW5kZXhlc1trZXldO1xuICAgICAgICBpZiAoaW5kZXguaGFzT3duUHJvcGVydHkoZmllbGROYW1lKSkge1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgY29uc3QgaW5kZXhOYW1lID0gYCR7ZmllbGROYW1lfV90ZXh0YDtcbiAgICAgIGNvbnN0IHRleHRJbmRleCA9IHtcbiAgICAgICAgW2luZGV4TmFtZV06IHsgW2ZpZWxkTmFtZV06ICd0ZXh0JyB9LFxuICAgICAgfTtcbiAgICAgIHJldHVybiB0aGlzLnNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgIHRleHRJbmRleCxcbiAgICAgICAgZXhpc3RpbmdJbmRleGVzLFxuICAgICAgICBzY2hlbWEuZmllbGRzXG4gICAgICApLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IDg1KSB7XG4gICAgICAgICAgLy8gSW5kZXggZXhpc3Qgd2l0aCBkaWZmZXJlbnQgb3B0aW9uc1xuICAgICAgICAgIHJldHVybiB0aGlzLnNldEluZGV4ZXNGcm9tTW9uZ28oY2xhc3NOYW1lKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICBnZXRJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX2FkYXB0aXZlQ29sbGVjdGlvbihjbGFzc05hbWUpXG4gICAgICAudGhlbihjb2xsZWN0aW9uID0+IGNvbGxlY3Rpb24uX21vbmdvQ29sbGVjdGlvbi5pbmRleGVzKCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBkcm9wSW5kZXgoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4OiBhbnkpIHtcbiAgICByZXR1cm4gdGhpcy5fYWRhcHRpdmVDb2xsZWN0aW9uKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKGNvbGxlY3Rpb24gPT4gY29sbGVjdGlvbi5fbW9uZ29Db2xsZWN0aW9uLmRyb3BJbmRleChpbmRleCkpXG4gICAgICAuY2F0Y2goZXJyID0+IHRoaXMuaGFuZGxlRXJyb3IoZXJyKSk7XG4gIH1cblxuICBkcm9wQWxsSW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9hZGFwdGl2ZUNvbGxlY3Rpb24oY2xhc3NOYW1lKVxuICAgICAgLnRoZW4oY29sbGVjdGlvbiA9PiBjb2xsZWN0aW9uLl9tb25nb0NvbGxlY3Rpb24uZHJvcEluZGV4ZXMoKSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxuXG4gIHVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzKCk6IFByb21pc2U8YW55PiB7XG4gICAgcmV0dXJuIHRoaXMuZ2V0QWxsQ2xhc3NlcygpXG4gICAgICAudGhlbihjbGFzc2VzID0+IHtcbiAgICAgICAgY29uc3QgcHJvbWlzZXMgPSBjbGFzc2VzLm1hcChzY2hlbWEgPT4ge1xuICAgICAgICAgIHJldHVybiB0aGlzLnNldEluZGV4ZXNGcm9tTW9uZ28oc2NoZW1hLmNsYXNzTmFtZSk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwocHJvbWlzZXMpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnIgPT4gdGhpcy5oYW5kbGVFcnJvcihlcnIpKTtcbiAgfVxufVxuXG5leHBvcnQgZGVmYXVsdCBNb25nb1N0b3JhZ2VBZGFwdGVyO1xuIl19