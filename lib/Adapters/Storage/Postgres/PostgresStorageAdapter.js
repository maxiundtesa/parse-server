"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.PostgresStorageAdapter = void 0;

var _PostgresClient = require("./PostgresClient");

var _node = _interopRequireDefault(require("parse/node"));

var _lodash = _interopRequireDefault(require("lodash"));

var _sql = _interopRequireDefault(require("./sql"));

var _xregexp = require("xregexp");

var _StorageAdapter = require("../StorageAdapter");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; var ownKeys = Object.keys(source); if (typeof Object.getOwnPropertySymbols === 'function') { ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(source).filter(function (sym) { return Object.getOwnPropertyDescriptor(source, sym).enumerable; })); } ownKeys.forEach(function (key) { _defineProperty(target, key, source[key]); }); } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const PostgresRelationDoesNotExistError = '42P01';
const PostgresDuplicateRelationError = '42P07';
const PostgresDuplicateColumnError = '42701';
const PostgresMissingColumnError = '42703';
const PostgresDuplicateObjectError = '42710';
const PostgresUniqueIndexViolationError = '23505';
const PostgresTransactionAbortedError = '25P02';

const logger = require('../../../logger');

const debug = function (...args) {
  args = ['PG: ' + arguments[0]].concat(args.slice(1, args.length));
  const log = logger.getLogger();
  log.debug.apply(log, args);
};

const parseTypeToPostgresType = type => {
  switch (type.type) {
    case 'String':
      return 'text';

    case 'Date':
      return 'timestamp with time zone';

    case 'Object':
      return 'jsonb';

    case 'File':
      return 'text';

    case 'Boolean':
      return 'boolean';

    case 'Pointer':
      return 'char(10)';

    case 'Number':
      return 'double precision';

    case 'GeoPoint':
      return 'point';

    case 'Bytes':
      return 'jsonb';

    case 'Polygon':
      return 'polygon';

    case 'Array':
      if (type.contents && type.contents.type === 'String') {
        return 'text[]';
      } else {
        return 'jsonb';
      }

    default:
      throw `no type for ${JSON.stringify(type)} yet`;
  }
};

const ParseToPosgresComparator = {
  $gt: '>',
  $lt: '<',
  $gte: '>=',
  $lte: '<='
};
const mongoAggregateToPostgres = {
  $dayOfMonth: 'DAY',
  $dayOfWeek: 'DOW',
  $dayOfYear: 'DOY',
  $isoDayOfWeek: 'ISODOW',
  $isoWeekYear: 'ISOYEAR',
  $hour: 'HOUR',
  $minute: 'MINUTE',
  $second: 'SECOND',
  $millisecond: 'MILLISECONDS',
  $month: 'MONTH',
  $week: 'WEEK',
  $year: 'YEAR'
};

const toPostgresValue = value => {
  if (typeof value === 'object') {
    if (value.__type === 'Date') {
      return value.iso;
    }

    if (value.__type === 'File') {
      return value.name;
    }
  }

  return value;
};

const transformValue = value => {
  if (typeof value === 'object' && value.__type === 'Pointer') {
    return value.objectId;
  }

  return value;
}; // Duplicate from then mongo adapter...


const emptyCLPS = Object.freeze({
  find: {},
  get: {},
  create: {},
  update: {},
  delete: {},
  addField: {}
});
const defaultCLPS = Object.freeze({
  find: {
    '*': true
  },
  get: {
    '*': true
  },
  create: {
    '*': true
  },
  update: {
    '*': true
  },
  delete: {
    '*': true
  },
  addField: {
    '*': true
  }
});

const toParseSchema = schema => {
  if (schema.className === '_User') {
    delete schema.fields._hashed_password;
  }

  if (schema.fields) {
    delete schema.fields._wperm;
    delete schema.fields._rperm;
  }

  let clps = defaultCLPS;

  if (schema.classLevelPermissions) {
    clps = _objectSpread({}, emptyCLPS, schema.classLevelPermissions);
  }

  let indexes = {};

  if (schema.indexes) {
    indexes = _objectSpread({}, schema.indexes);
  }

  return {
    className: schema.className,
    fields: schema.fields,
    classLevelPermissions: clps,
    indexes
  };
};

const toPostgresSchema = schema => {
  if (!schema) {
    return schema;
  }

  schema.fields = schema.fields || {};
  schema.fields._wperm = {
    type: 'Array',
    contents: {
      type: 'String'
    }
  };
  schema.fields._rperm = {
    type: 'Array',
    contents: {
      type: 'String'
    }
  };

  if (schema.className === '_User') {
    schema.fields._hashed_password = {
      type: 'String'
    };
    schema.fields._password_history = {
      type: 'Array'
    };
  }

  return schema;
};

const handleDotFields = object => {
  Object.keys(object).forEach(fieldName => {
    if (fieldName.indexOf('.') > -1) {
      const components = fieldName.split('.');
      const first = components.shift();
      object[first] = object[first] || {};
      let currentObj = object[first];
      let next;
      let value = object[fieldName];

      if (value && value.__op === 'Delete') {
        value = undefined;
      }
      /* eslint-disable no-cond-assign */


      while (next = components.shift()) {
        /* eslint-enable no-cond-assign */
        currentObj[next] = currentObj[next] || {};

        if (components.length === 0) {
          currentObj[next] = value;
        }

        currentObj = currentObj[next];
      }

      delete object[fieldName];
    }
  });
  return object;
};

const transformDotFieldToComponents = fieldName => {
  return fieldName.split('.').map((cmpt, index) => {
    if (index === 0) {
      return `"${cmpt}"`;
    }

    return `'${cmpt}'`;
  });
};

const transformDotField = fieldName => {
  if (fieldName.indexOf('.') === -1) {
    return `"${fieldName}"`;
  }

  const components = transformDotFieldToComponents(fieldName);
  let name = components.slice(0, components.length - 1).join('->');
  name += '->>' + components[components.length - 1];
  return name;
};

const transformAggregateField = fieldName => {
  if (typeof fieldName !== 'string') {
    return fieldName;
  }

  if (fieldName === '$_created_at') {
    return 'createdAt';
  }

  if (fieldName === '$_updated_at') {
    return 'updatedAt';
  }

  return fieldName.substr(1);
};

const validateKeys = object => {
  if (typeof object == 'object') {
    for (const key in object) {
      if (typeof object[key] == 'object') {
        validateKeys(object[key]);
      }

      if (key.includes('$') || key.includes('.')) {
        throw new _node.default.Error(_node.default.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
      }
    }
  }
}; // Returns the list of join tables on a schema


const joinTablesForSchema = schema => {
  const list = [];

  if (schema) {
    Object.keys(schema.fields).forEach(field => {
      if (schema.fields[field].type === 'Relation') {
        list.push(`_Join:${field}:${schema.className}`);
      }
    });
  }

  return list;
};

const buildWhereClause = ({
  schema,
  query,
  index
}) => {
  const patterns = [];
  let values = [];
  const sorts = [];
  schema = toPostgresSchema(schema);

  for (const fieldName in query) {
    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const initialPatternsLength = patterns.length;
    const fieldValue = query[fieldName]; // nothingin the schema, it's gonna blow up

    if (!schema.fields[fieldName]) {
      // as it won't exist
      if (fieldValue && fieldValue.$exists === false) {
        continue;
      }
    }

    if (fieldName.indexOf('.') >= 0) {
      let name = transformDotField(fieldName);

      if (fieldValue === null) {
        patterns.push(`${name} IS NULL`);
      } else {
        if (fieldValue.$in) {
          const inPatterns = [];
          name = transformDotFieldToComponents(fieldName).join('->');
          fieldValue.$in.forEach(listElem => {
            if (typeof listElem === 'string') {
              inPatterns.push(`"${listElem}"`);
            } else {
              inPatterns.push(`${listElem}`);
            }
          });
          patterns.push(`(${name})::jsonb @> '[${inPatterns.join()}]'::jsonb`);
        } else if (fieldValue.$regex) {// Handle later
        } else {
          patterns.push(`${name} = '${fieldValue}'`);
        }
      }
    } else if (fieldValue === null || fieldValue === undefined) {
      patterns.push(`$${index}:name IS NULL`);
      values.push(fieldName);
      index += 1;
      continue;
    } else if (typeof fieldValue === 'string') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (typeof fieldValue === 'boolean') {
      patterns.push(`$${index}:name = $${index + 1}`); // Can't cast boolean to double precision

      if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Number') {
        // Should always return zero results
        const MAX_INT_PLUS_ONE = 9223372036854775808;
        values.push(fieldName, MAX_INT_PLUS_ONE);
      } else {
        values.push(fieldName, fieldValue);
      }

      index += 2;
    } else if (typeof fieldValue === 'number') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (['$or', '$nor', '$and'].includes(fieldName)) {
      const clauses = [];
      const clauseValues = [];
      fieldValue.forEach(subQuery => {
        const clause = buildWhereClause({
          schema,
          query: subQuery,
          index
        });

        if (clause.pattern.length > 0) {
          clauses.push(clause.pattern);
          clauseValues.push(...clause.values);
          index += clause.values.length;
        }
      });
      const orOrAnd = fieldName === '$and' ? ' AND ' : ' OR ';
      const not = fieldName === '$nor' ? ' NOT ' : '';
      patterns.push(`${not}(${clauses.join(orOrAnd)})`);
      values.push(...clauseValues);
    }

    if (fieldValue.$ne !== undefined) {
      if (isArrayField) {
        fieldValue.$ne = JSON.stringify([fieldValue.$ne]);
        patterns.push(`NOT array_contains($${index}:name, $${index + 1})`);
      } else {
        if (fieldValue.$ne === null) {
          patterns.push(`$${index}:name IS NOT NULL`);
          values.push(fieldName);
          index += 1;
          continue;
        } else {
          // if not null, we need to manually exclude null
          patterns.push(`($${index}:name <> $${index + 1} OR $${index}:name IS NULL)`);
        }
      } // TODO: support arrays


      values.push(fieldName, fieldValue.$ne);
      index += 2;
    }

    if (fieldValue.$eq !== undefined) {
      if (fieldValue.$eq === null) {
        patterns.push(`$${index}:name IS NULL`);
        values.push(fieldName);
        index += 1;
      } else {
        patterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.$eq);
        index += 2;
      }
    }

    const isInOrNin = Array.isArray(fieldValue.$in) || Array.isArray(fieldValue.$nin);

    if (Array.isArray(fieldValue.$in) && isArrayField && schema.fields[fieldName].contents && schema.fields[fieldName].contents.type === 'String') {
      const inPatterns = [];
      let allowNull = false;
      values.push(fieldName);
      fieldValue.$in.forEach((listElem, listIndex) => {
        if (listElem === null) {
          allowNull = true;
        } else {
          values.push(listElem);
          inPatterns.push(`$${index + 1 + listIndex - (allowNull ? 1 : 0)}`);
        }
      });

      if (allowNull) {
        patterns.push(`($${index}:name IS NULL OR $${index}:name && ARRAY[${inPatterns.join()}])`);
      } else {
        patterns.push(`$${index}:name && ARRAY[${inPatterns.join()}]`);
      }

      index = index + 1 + inPatterns.length;
    } else if (isInOrNin) {
      var createConstraint = (baseArray, notIn) => {
        const not = notIn ? ' NOT ' : '';

        if (baseArray.length > 0) {
          if (isArrayField) {
            patterns.push(`${not} array_contains($${index}:name, $${index + 1})`);
            values.push(fieldName, JSON.stringify(baseArray));
            index += 2;
          } else {
            // Handle Nested Dot Notation Above
            if (fieldName.indexOf('.') >= 0) {
              return;
            }

            const inPatterns = [];
            values.push(fieldName);
            baseArray.forEach((listElem, listIndex) => {
              if (listElem !== null) {
                values.push(listElem);
                inPatterns.push(`$${index + 1 + listIndex}`);
              }
            });
            patterns.push(`$${index}:name ${not} IN (${inPatterns.join()})`);
            index = index + 1 + inPatterns.length;
          }
        } else if (!notIn) {
          values.push(fieldName);
          patterns.push(`$${index}:name IS NULL`);
          index = index + 1;
        } else {
          // Handle empty array
          if (notIn) {
            patterns.push('1 = 1'); // Return all values
          } else {
            patterns.push('1 = 2'); // Return no values
          }
        }
      };

      if (fieldValue.$in) {
        createConstraint(_lodash.default.flatMap(fieldValue.$in, elt => elt), false);
      }

      if (fieldValue.$nin) {
        createConstraint(_lodash.default.flatMap(fieldValue.$nin, elt => elt), true);
      }
    } else if (typeof fieldValue.$in !== 'undefined') {
      throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $in value');
    } else if (typeof fieldValue.$nin !== 'undefined') {
      throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $nin value');
    }

    if (Array.isArray(fieldValue.$all) && isArrayField) {
      if (isAnyValueRegexStartsWith(fieldValue.$all)) {
        if (!isAllValuesRegexOrNone(fieldValue.$all)) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'All $all values must be of regex type or none: ' + fieldValue.$all);
        }

        for (let i = 0; i < fieldValue.$all.length; i += 1) {
          const value = processRegexPattern(fieldValue.$all[i].$regex);
          fieldValue.$all[i] = value.substring(1) + '%';
        }

        patterns.push(`array_contains_all_regex($${index}:name, $${index + 1}::jsonb)`);
      } else {
        patterns.push(`array_contains_all($${index}:name, $${index + 1}::jsonb)`);
      }

      values.push(fieldName, JSON.stringify(fieldValue.$all));
      index += 2;
    }

    if (typeof fieldValue.$exists !== 'undefined') {
      if (fieldValue.$exists) {
        patterns.push(`$${index}:name IS NOT NULL`);
      } else {
        patterns.push(`$${index}:name IS NULL`);
      }

      values.push(fieldName);
      index += 1;
    }

    if (fieldValue.$containedBy) {
      const arr = fieldValue.$containedBy;

      if (!(arr instanceof Array)) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $containedBy: should be an array`);
      }

      patterns.push(`$${index}:name <@ $${index + 1}::jsonb`);
      values.push(fieldName, JSON.stringify(arr));
      index += 2;
    }

    if (fieldValue.$text) {
      const search = fieldValue.$text.$search;
      let language = 'english';

      if (typeof search !== 'object') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $search, should be object`);
      }

      if (!search.$term || typeof search.$term !== 'string') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $term, should be string`);
      }

      if (search.$language && typeof search.$language !== 'string') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $language, should be string`);
      } else if (search.$language) {
        language = search.$language;
      }

      if (search.$caseSensitive && typeof search.$caseSensitive !== 'boolean') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $caseSensitive, should be boolean`);
      } else if (search.$caseSensitive) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $caseSensitive not supported, please use $regex or create a separate lower case column.`);
      }

      if (search.$diacriticSensitive && typeof search.$diacriticSensitive !== 'boolean') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive, should be boolean`);
      } else if (search.$diacriticSensitive === false) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive - false not supported, install Postgres Unaccent Extension`);
      }

      patterns.push(`to_tsvector($${index}, $${index + 1}:name) @@ to_tsquery($${index + 2}, $${index + 3})`);
      values.push(language, fieldName, language, search.$term);
      index += 4;
    }

    if (fieldValue.$nearSphere) {
      const point = fieldValue.$nearSphere;
      const distance = fieldValue.$maxDistance;
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      sorts.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) ASC`);
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }

    if (fieldValue.$within && fieldValue.$within.$box) {
      const box = fieldValue.$within.$box;
      const left = box[0].longitude;
      const bottom = box[0].latitude;
      const right = box[1].longitude;
      const top = box[1].latitude;
      patterns.push(`$${index}:name::point <@ $${index + 1}::box`);
      values.push(fieldName, `((${left}, ${bottom}), (${right}, ${top}))`);
      index += 2;
    }

    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$centerSphere) {
      const centerSphere = fieldValue.$geoWithin.$centerSphere;

      if (!(centerSphere instanceof Array) || centerSphere.length < 2) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere should be an array of Parse.GeoPoint and distance');
      } // Get point, convert to geo point if necessary and validate


      let point = centerSphere[0];

      if (point instanceof Array && point.length === 2) {
        point = new _node.default.GeoPoint(point[1], point[0]);
      } else if (!GeoPointCoder.isValidJSON(point)) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere geo point invalid');
      }

      _node.default.GeoPoint._validate(point.latitude, point.longitude); // Get distance and validate


      const distance = centerSphere[1];

      if (isNaN(distance) || distance < 0) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere distance invalid');
      }

      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }

    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$polygon) {
      const polygon = fieldValue.$geoWithin.$polygon;
      let points;

      if (typeof polygon === 'object' && polygon.__type === 'Polygon') {
        if (!polygon.coordinates || polygon.coordinates.length < 3) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; Polygon.coordinates should contain at least 3 lon/lat pairs');
        }

        points = polygon.coordinates;
      } else if (polygon instanceof Array) {
        if (polygon.length < 3) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $polygon should contain at least 3 GeoPoints');
        }

        points = polygon;
      } else {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, "bad $geoWithin value; $polygon should be Polygon object or Array of Parse.GeoPoint's");
      }

      points = points.map(point => {
        if (point instanceof Array && point.length === 2) {
          _node.default.GeoPoint._validate(point[1], point[0]);

          return `(${point[0]}, ${point[1]})`;
        }

        if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value');
        } else {
          _node.default.GeoPoint._validate(point.latitude, point.longitude);
        }

        return `(${point.longitude}, ${point.latitude})`;
      }).join(', ');
      patterns.push(`$${index}:name::point <@ $${index + 1}::polygon`);
      values.push(fieldName, `(${points})`);
      index += 2;
    }

    if (fieldValue.$geoIntersects && fieldValue.$geoIntersects.$point) {
      const point = fieldValue.$geoIntersects.$point;

      if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoIntersect value; $point should be GeoPoint');
      } else {
        _node.default.GeoPoint._validate(point.latitude, point.longitude);
      }

      patterns.push(`$${index}:name::polygon @> $${index + 1}::point`);
      values.push(fieldName, `(${point.longitude}, ${point.latitude})`);
      index += 2;
    }

    if (fieldValue.$regex) {
      let regex = fieldValue.$regex;
      let operator = '~';
      const opts = fieldValue.$options;

      if (opts) {
        if (opts.indexOf('i') >= 0) {
          operator = '~*';
        }

        if (opts.indexOf('x') >= 0) {
          regex = removeWhiteSpace(regex);
        }
      }

      const name = transformDotField(fieldName);
      regex = processRegexPattern(regex);
      patterns.push(`$${index}:raw ${operator} '$${index + 1}:raw'`);
      values.push(name, regex);
      index += 2;
    }

    if (fieldValue.__type === 'Pointer') {
      if (isArrayField) {
        patterns.push(`array_contains($${index}:name, $${index + 1})`);
        values.push(fieldName, JSON.stringify([fieldValue]));
        index += 2;
      } else {
        patterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      }
    }

    if (fieldValue.__type === 'Date') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue.iso);
      index += 2;
    }

    if (fieldValue.__type === 'GeoPoint') {
      patterns.push('$' + index + ':name ~= POINT($' + (index + 1) + ', $' + (index + 2) + ')');
      values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
      index += 3;
    }

    if (fieldValue.__type === 'Polygon') {
      const value = convertPolygonToSQL(fieldValue.coordinates);
      patterns.push(`$${index}:name ~= $${index + 1}::polygon`);
      values.push(fieldName, value);
      index += 2;
    }

    Object.keys(ParseToPosgresComparator).forEach(cmp => {
      if (fieldValue[cmp] || fieldValue[cmp] === 0) {
        const pgComparator = ParseToPosgresComparator[cmp];
        patterns.push(`$${index}:name ${pgComparator} $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue[cmp]));
        index += 2;
      }
    });

    if (initialPatternsLength === patterns.length) {
      throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support this query type yet ${JSON.stringify(fieldValue)}`);
    }
  }

  values = values.map(transformValue);
  return {
    pattern: patterns.join(' AND '),
    values,
    sorts
  };
};

class PostgresStorageAdapter {
  // Private
  constructor({
    uri,
    collectionPrefix = '',
    databaseOptions
  }) {
    this._collectionPrefix = collectionPrefix;
    const {
      client,
      pgp
    } = (0, _PostgresClient.createClient)(uri, databaseOptions);
    this._client = client;
    this._pgp = pgp;
    this.canSortOnJoinTables = false;
  }

  handleShutdown() {
    if (!this._client) {
      return;
    }

    this._client.$pool.end();
  }

  _ensureSchemaCollectionExists(conn) {
    conn = conn || this._client;
    return conn.none('CREATE TABLE IF NOT EXISTS "_SCHEMA" ( "className" varChar(120), "schema" jsonb, "isParseClass" bool, PRIMARY KEY ("className") )').catch(error => {
      if (error.code === PostgresDuplicateRelationError || error.code === PostgresUniqueIndexViolationError || error.code === PostgresDuplicateObjectError) {// Table already exists, must have been created by a different request. Ignore error.
      } else {
        throw error;
      }
    });
  }

  classExists(name) {
    return this._client.one('SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)', [name], a => a.exists);
  }

  setClassLevelPermissions(className, CLPs) {
    const self = this;
    return this._client.task('set-class-level-permissions', function* (t) {
      yield self._ensureSchemaCollectionExists(t);
      const values = [className, 'schema', 'classLevelPermissions', JSON.stringify(CLPs)];
      yield t.none(`UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className"=$1`, values);
    });
  }

  setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields, conn) {
    conn = conn || this._client;
    const self = this;

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

    const deletedIndexes = [];
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
        deletedIndexes.push(name);
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
    return conn.tx('set-indexes-with-schema-format', function* (t) {
      if (insertedIndexes.length > 0) {
        yield self.createIndexes(className, insertedIndexes, t);
      }

      if (deletedIndexes.length > 0) {
        yield self.dropIndexes(className, deletedIndexes, t);
      }

      yield self._ensureSchemaCollectionExists(t);
      yield t.none('UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className"=$1', [className, 'schema', 'indexes', JSON.stringify(existingIndexes)]);
    });
  }

  createClass(className, schema, conn) {
    conn = conn || this._client;
    return conn.tx('create-class', t => {
      const q1 = this.createTable(className, schema, t);
      const q2 = t.none('INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES ($<className>, $<schema>, true)', {
        className,
        schema
      });
      const q3 = this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields, t);
      return t.batch([q1, q2, q3]);
    }).then(() => {
      return toParseSchema(schema);
    }).catch(err => {
      if (err.data[0].result.code === PostgresTransactionAbortedError) {
        err = err.data[1].result;
      }

      if (err.code === PostgresUniqueIndexViolationError && err.detail.includes(className)) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, `Class ${className} already exists.`);
      }

      throw err;
    });
  } // Just create a table, do not insert in schema


  createTable(className, schema, conn) {
    conn = conn || this._client;
    const self = this;
    debug('createTable', className, schema);
    const valuesArray = [];
    const patternsArray = [];
    const fields = Object.assign({}, schema.fields);

    if (className === '_User') {
      fields._email_verify_token_expires_at = {
        type: 'Date'
      };
      fields._email_verify_token = {
        type: 'String'
      };
      fields._account_lockout_expires_at = {
        type: 'Date'
      };
      fields._failed_login_count = {
        type: 'Number'
      };
      fields._perishable_token = {
        type: 'String'
      };
      fields._perishable_token_expires_at = {
        type: 'Date'
      };
      fields._password_changed_at = {
        type: 'Date'
      };
      fields._password_history = {
        type: 'Array'
      };
    }

    let index = 2;
    const relations = [];
    Object.keys(fields).forEach(fieldName => {
      const parseType = fields[fieldName]; // Skip when it's a relation
      // We'll create the tables later

      if (parseType.type === 'Relation') {
        relations.push(fieldName);
        return;
      }

      if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
        parseType.contents = {
          type: 'String'
        };
      }

      valuesArray.push(fieldName);
      valuesArray.push(parseTypeToPostgresType(parseType));
      patternsArray.push(`$${index}:name $${index + 1}:raw`);

      if (fieldName === 'objectId') {
        patternsArray.push(`PRIMARY KEY ($${index}:name)`);
      }

      index = index + 2;
    });
    const qs = `CREATE TABLE IF NOT EXISTS $1:name (${patternsArray.join()})`;
    const values = [className, ...valuesArray];
    debug(qs, values);
    return conn.task('create-table', function* (t) {
      try {
        yield self._ensureSchemaCollectionExists(t);
        yield t.none(qs, values);
      } catch (error) {
        if (error.code !== PostgresDuplicateRelationError) {
          throw error;
        } // ELSE: Table already exists, must have been created by a different request. Ignore the error.

      }

      yield t.tx('create-table-tx', tx => {
        return tx.batch(relations.map(fieldName => {
          return tx.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', {
            joinTable: `_Join:${fieldName}:${className}`
          });
        }));
      });
    });
  }

  schemaUpgrade(className, schema, conn) {
    debug('schemaUpgrade', {
      className,
      schema
    });
    conn = conn || this._client;
    const self = this;
    return conn.tx('schema-upgrade', function* (t) {
      const columns = yield t.map('SELECT column_name FROM information_schema.columns WHERE table_name = $<className>', {
        className
      }, a => a.column_name);
      const newColumns = Object.keys(schema.fields).filter(item => columns.indexOf(item) === -1).map(fieldName => self.addFieldIfNotExists(className, fieldName, schema.fields[fieldName], t));
      yield t.batch(newColumns);
    });
  }

  addFieldIfNotExists(className, fieldName, type, conn) {
    // TODO: Must be revised for invalid logic...
    debug('addFieldIfNotExists', {
      className,
      fieldName,
      type
    });
    conn = conn || this._client;
    const self = this;
    return conn.tx('add-field-if-not-exists', function* (t) {
      if (type.type !== 'Relation') {
        try {
          yield t.none('ALTER TABLE $<className:name> ADD COLUMN $<fieldName:name> $<postgresType:raw>', {
            className,
            fieldName,
            postgresType: parseTypeToPostgresType(type)
          });
        } catch (error) {
          if (error.code === PostgresRelationDoesNotExistError) {
            return yield self.createClass(className, {
              fields: {
                [fieldName]: type
              }
            }, t);
          }

          if (error.code !== PostgresDuplicateColumnError) {
            throw error;
          } // Column already exists, created by other request. Carry on to see if it's the right type.

        }
      } else {
        yield t.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', {
          joinTable: `_Join:${fieldName}:${className}`
        });
      }

      const result = yield t.any('SELECT "schema" FROM "_SCHEMA" WHERE "className" = $<className> and ("schema"::json->\'fields\'->$<fieldName>) is not null', {
        className,
        fieldName
      });

      if (result[0]) {
        throw 'Attempted to add a field that already exists';
      } else {
        const path = `{fields,${fieldName}}`;
        yield t.none('UPDATE "_SCHEMA" SET "schema"=jsonb_set("schema", $<path>, $<type>)  WHERE "className"=$<className>', {
          path,
          type,
          className
        });
      }
    });
  } // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.


  deleteClass(className) {
    const operations = [{
      query: `DROP TABLE IF EXISTS $1:name`,
      values: [className]
    }, {
      query: `DELETE FROM "_SCHEMA" WHERE "className" = $1`,
      values: [className]
    }];
    return this._client.tx(t => t.none(this._pgp.helpers.concat(operations))).then(() => className.indexOf('_Join:') != 0); // resolves with false when _Join table
  } // Delete all data known to this adapter. Used for testing.


  deleteAllClasses() {
    const now = new Date().getTime();
    const helpers = this._pgp.helpers;
    debug('deleteAllClasses');
    return this._client.task('delete-all-classes', function* (t) {
      try {
        const results = yield t.any('SELECT * FROM "_SCHEMA"');
        const joins = results.reduce((list, schema) => {
          return list.concat(joinTablesForSchema(schema.schema));
        }, []);
        const classes = ['_SCHEMA', '_PushStatus', '_JobStatus', '_JobSchedule', '_Hooks', '_GlobalConfig', '_Audience', ...results.map(result => result.className), ...joins];
        const queries = classes.map(className => ({
          query: 'DROP TABLE IF EXISTS $<className:name>',
          values: {
            className
          }
        }));
        yield t.tx(tx => tx.none(helpers.concat(queries)));
      } catch (error) {
        if (error.code !== PostgresRelationDoesNotExistError) {
          throw error;
        } // No _SCHEMA collection. Don't delete anything.

      }
    }).then(() => {
      debug(`deleteAllClasses done in ${new Date().getTime() - now}`);
    });
  } // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.
  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.
  // Returns a Promise.


  deleteFields(className, schema, fieldNames) {
    debug('deleteFields', className, fieldNames);
    fieldNames = fieldNames.reduce((list, fieldName) => {
      const field = schema.fields[fieldName];

      if (field.type !== 'Relation') {
        list.push(fieldName);
      }

      delete schema.fields[fieldName];
      return list;
    }, []);
    const values = [className, ...fieldNames];
    const columns = fieldNames.map((name, idx) => {
      return `$${idx + 2}:name`;
    }).join(', DROP COLUMN');
    return this._client.tx('delete-fields', function* (t) {
      yield t.none('UPDATE "_SCHEMA" SET "schema"=$<schema> WHERE "className"=$<className>', {
        schema,
        className
      });

      if (values.length > 1) {
        yield t.none(`ALTER TABLE $1:name DROP COLUMN ${columns}`, values);
      }
    });
  } // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.


  getAllClasses() {
    const self = this;
    return this._client.task('get-all-classes', function* (t) {
      yield self._ensureSchemaCollectionExists(t);
      return yield t.map('SELECT * FROM "_SCHEMA"', null, row => toParseSchema(_objectSpread({
        className: row.className
      }, row.schema)));
    });
  } // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.


  getClass(className) {
    debug('getClass', className);
    return this._client.any('SELECT * FROM "_SCHEMA" WHERE "className"=$<className>', {
      className
    }).then(result => {
      if (result.length !== 1) {
        throw undefined;
      }

      return result[0].schema;
    }).then(toParseSchema);
  } // TODO: remove the mongo format dependency in the return value


  createObject(className, schema, object) {
    debug('createObject', className, object);
    let columnsArray = [];
    const valuesArray = [];
    schema = toPostgresSchema(schema);
    const geoPoints = {};
    object = handleDotFields(object);
    validateKeys(object);
    Object.keys(object).forEach(fieldName => {
      if (object[fieldName] === null) {
        return;
      }

      var authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);

      if (authDataMatch) {
        var provider = authDataMatch[1];
        object['authData'] = object['authData'] || {};
        object['authData'][provider] = object[fieldName];
        delete object[fieldName];
        fieldName = 'authData';
      }

      columnsArray.push(fieldName);

      if (!schema.fields[fieldName] && className === '_User') {
        if (fieldName === '_email_verify_token' || fieldName === '_failed_login_count' || fieldName === '_perishable_token' || fieldName === '_password_history') {
          valuesArray.push(object[fieldName]);
        }

        if (fieldName === '_email_verify_token_expires_at') {
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
        }

        if (fieldName === '_account_lockout_expires_at' || fieldName === '_perishable_token_expires_at' || fieldName === '_password_changed_at') {
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
        }

        return;
      }

      switch (schema.fields[fieldName].type) {
        case 'Date':
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }

          break;

        case 'Pointer':
          valuesArray.push(object[fieldName].objectId);
          break;

        case 'Array':
          if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
            valuesArray.push(object[fieldName]);
          } else {
            valuesArray.push(JSON.stringify(object[fieldName]));
          }

          break;

        case 'Object':
        case 'Bytes':
        case 'String':
        case 'Number':
        case 'Boolean':
          valuesArray.push(object[fieldName]);
          break;

        case 'File':
          valuesArray.push(object[fieldName].name);
          break;

        case 'Polygon':
          {
            const value = convertPolygonToSQL(object[fieldName].coordinates);
            valuesArray.push(value);
            break;
          }

        case 'GeoPoint':
          // pop the point and process later
          geoPoints[fieldName] = object[fieldName];
          columnsArray.pop();
          break;

        default:
          throw `Type ${schema.fields[fieldName].type} not supported yet`;
      }
    });
    columnsArray = columnsArray.concat(Object.keys(geoPoints));
    const initialValues = valuesArray.map((val, index) => {
      let termination = '';
      const fieldName = columnsArray[index];

      if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
        termination = '::text[]';
      } else if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Array') {
        termination = '::jsonb';
      }

      return `$${index + 2 + columnsArray.length}${termination}`;
    });
    const geoPointsInjects = Object.keys(geoPoints).map(key => {
      const value = geoPoints[key];
      valuesArray.push(value.longitude, value.latitude);
      const l = valuesArray.length + columnsArray.length;
      return `POINT($${l}, $${l + 1})`;
    });
    const columnsPattern = columnsArray.map((col, index) => `$${index + 2}:name`).join();
    const valuesPattern = initialValues.concat(geoPointsInjects).join();
    const qs = `INSERT INTO $1:name (${columnsPattern}) VALUES (${valuesPattern})`;
    const values = [className, ...columnsArray, ...valuesArray];
    debug(qs, values);
    return this._client.none(qs, values).then(() => ({
      ops: [object]
    })).catch(error => {
      if (error.code === PostgresUniqueIndexViolationError) {
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;

        if (error.constraint) {
          const matches = error.constraint.match(/unique_([a-zA-Z]+)/);

          if (matches && Array.isArray(matches)) {
            err.userInfo = {
              duplicated_field: matches[1]
            };
          }
        }

        error = err;
      }

      throw error;
    });
  } // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.


  deleteObjectsByQuery(className, schema, query) {
    debug('deleteObjectsByQuery', className, query);
    const values = [className];
    const index = 2;
    const where = buildWhereClause({
      schema,
      index,
      query
    });
    values.push(...where.values);

    if (Object.keys(query).length === 0) {
      where.pattern = 'TRUE';
    }

    const qs = `WITH deleted AS (DELETE FROM $1:name WHERE ${where.pattern} RETURNING *) SELECT count(*) FROM deleted`;
    debug(qs, values);
    return this._client.one(qs, values, a => +a.count).then(count => {
      if (count === 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      } else {
        return count;
      }
    }).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      } // ELSE: Don't delete anything if doesn't exist

    });
  } // Return value not currently well specified.


  findOneAndUpdate(className, schema, query, update) {
    debug('findOneAndUpdate', className, query, update);
    return this.updateObjectsByQuery(className, schema, query, update).then(val => val[0]);
  } // Apply the update to all objects that match the given Parse Query.


  updateObjectsByQuery(className, schema, query, update) {
    debug('updateObjectsByQuery', className, query, update);
    const updatePatterns = [];
    const values = [className];
    let index = 2;
    schema = toPostgresSchema(schema);

    const originalUpdate = _objectSpread({}, update); // Set flag for dot notation fields


    const dotNotationOptions = {};
    Object.keys(update).forEach(fieldName => {
      if (fieldName.indexOf('.') > -1) {
        const components = fieldName.split('.');
        const first = components.shift();
        dotNotationOptions[first] = true;
      } else {
        dotNotationOptions[fieldName] = false;
      }
    });
    update = handleDotFields(update); // Resolve authData first,
    // So we don't end up with multiple key updates

    for (const fieldName in update) {
      const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);

      if (authDataMatch) {
        var provider = authDataMatch[1];
        const value = update[fieldName];
        delete update[fieldName];
        update['authData'] = update['authData'] || {};
        update['authData'][provider] = value;
      }
    }

    for (const fieldName in update) {
      const fieldValue = update[fieldName]; // Drop any undefined values.

      if (typeof fieldValue === 'undefined') {
        delete update[fieldName];
      } else if (fieldValue === null) {
        updatePatterns.push(`$${index}:name = NULL`);
        values.push(fieldName);
        index += 1;
      } else if (fieldName == 'authData') {
        // This recursively sets the json_object
        // Only 1 level deep
        const generate = (jsonb, key, value) => {
          return `json_object_set_key(COALESCE(${jsonb}, '{}'::jsonb), ${key}, ${value})::jsonb`;
        };

        const lastKey = `$${index}:name`;
        const fieldNameIndex = index;
        index += 1;
        values.push(fieldName);
        const update = Object.keys(fieldValue).reduce((lastKey, key) => {
          const str = generate(lastKey, `$${index}::text`, `$${index + 1}::jsonb`);
          index += 2;
          let value = fieldValue[key];

          if (value) {
            if (value.__op === 'Delete') {
              value = null;
            } else {
              value = JSON.stringify(value);
            }
          }

          values.push(key, value);
          return str;
        }, lastKey);
        updatePatterns.push(`$${fieldNameIndex}:name = ${update}`);
      } else if (fieldValue.__op === 'Increment') {
        updatePatterns.push(`$${index}:name = COALESCE($${index}:name, 0) + $${index + 1}`);
        values.push(fieldName, fieldValue.amount);
        index += 2;
      } else if (fieldValue.__op === 'Add') {
        updatePatterns.push(`$${index}:name = array_add(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'Delete') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, null);
        index += 2;
      } else if (fieldValue.__op === 'Remove') {
        updatePatterns.push(`$${index}:name = array_remove(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'AddUnique') {
        updatePatterns.push(`$${index}:name = array_add_unique(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldName === 'updatedAt') {
        //TODO: stop special casing this. It should check for __type === 'Date' and use .iso
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'string') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'boolean') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'Pointer') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      } else if (fieldValue.__type === 'Date') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue instanceof Date) {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'File') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue.__type === 'GeoPoint') {
        updatePatterns.push(`$${index}:name = POINT($${index + 1}, $${index + 2})`);
        values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
        index += 3;
      } else if (fieldValue.__type === 'Polygon') {
        const value = convertPolygonToSQL(fieldValue.coordinates);
        updatePatterns.push(`$${index}:name = $${index + 1}::polygon`);
        values.push(fieldName, value);
        index += 2;
      } else if (fieldValue.__type === 'Relation') {// noop
      } else if (typeof fieldValue === 'number') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'object' && schema.fields[fieldName] && schema.fields[fieldName].type === 'Object') {
        // Gather keys to increment
        const keysToIncrement = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set
          // Note that Object.keys is iterating over the **original** update object
          // and that some of the keys of the original update could be null or undefined:
          // (See the above check `if (fieldValue === null || typeof fieldValue == "undefined")`)
          const value = originalUpdate[k];
          return value && value.__op === 'Increment' && k.split('.').length === 2 && k.split('.')[0] === fieldName;
        }).map(k => k.split('.')[1]);
        let incrementPatterns = '';

        if (keysToIncrement.length > 0) {
          incrementPatterns = ' || ' + keysToIncrement.map(c => {
            const amount = fieldValue[c].amount;
            return `CONCAT('{"${c}":', COALESCE($${index}:name->>'${c}','0')::int + ${amount}, '}')::jsonb`;
          }).join(' || '); // Strip the keys

          keysToIncrement.forEach(key => {
            delete fieldValue[key];
          });
        }

        const keysToDelete = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set.
          const value = originalUpdate[k];
          return value && value.__op === 'Delete' && k.split('.').length === 2 && k.split('.')[0] === fieldName;
        }).map(k => k.split('.')[1]);
        const deletePatterns = keysToDelete.reduce((p, c, i) => {
          return p + ` - '$${index + 1 + i}:value'`;
        }, ''); // Override Object

        let updateObject = "'{}'::jsonb";

        if (dotNotationOptions[fieldName]) {
          // Merge Object
          updateObject = `COALESCE($${index}:name, '{}'::jsonb)`;
        }

        updatePatterns.push(`$${index}:name = (${updateObject} ${deletePatterns} ${incrementPatterns} || $${index + 1 + keysToDelete.length}::jsonb )`);
        values.push(fieldName, ...keysToDelete, JSON.stringify(fieldValue));
        index += 2 + keysToDelete.length;
      } else if (Array.isArray(fieldValue) && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array') {
        const expectedType = parseTypeToPostgresType(schema.fields[fieldName]);

        if (expectedType === 'text[]') {
          updatePatterns.push(`$${index}:name = $${index + 1}::text[]`);
          values.push(fieldName, fieldValue);
          index += 2;
        } else {
          values.push(fieldName);

          const buildSQLArray = fieldValue => {
            let pattern = 'json_build_array(';

            for (let i = 0; i < fieldValue.length; i += 1) {
              const element = fieldValue[i];
              let type = '';

              if (Array.isArray(element)) {
                pattern += buildSQLArray(element) + ',';
                continue;
              } else if (typeof element == 'object') {
                type = '::json';
              }

              values.push(element);
              pattern += `$${index + 1}${type},`;
              index += 1;
            } // remove last comma


            if (fieldValue.length > 0) {
              pattern = pattern.slice(0, -1);
            }

            pattern += ')';
            return pattern;
          };

          const sql = `$${index}:name = ${buildSQLArray(fieldValue)}`;
          updatePatterns.push(sql);
          index += 1;
        }
      } else {
        debug('Not supported update', fieldName, fieldValue);
        return Promise.reject(new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support update ${JSON.stringify(fieldValue)} yet`));
      }
    }

    const where = buildWhereClause({
      schema,
      index,
      query
    });
    values.push(...where.values);
    const whereClause = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const qs = `UPDATE $1:name SET ${updatePatterns.join()} ${whereClause} RETURNING *`;
    debug('update: ', qs, values);
    return this._client.any(qs, values);
  } // Hopefully, we can get rid of this. It's only used for config and hooks.


  upsertOneObject(className, schema, query, update) {
    debug('upsertOneObject', {
      className,
      query,
      update
    });
    const createValue = Object.assign({}, query, update);
    return this.createObject(className, schema, createValue).catch(error => {
      // ignore duplicate value errors as it's upsert
      if (error.code !== _node.default.Error.DUPLICATE_VALUE) {
        throw error;
      }

      return this.findOneAndUpdate(className, schema, query, update);
    });
  }

  find(className, schema, query, {
    skip,
    limit,
    sort,
    keys
  }) {
    debug('find', className, query, {
      skip,
      limit,
      sort,
      keys
    });
    const hasLimit = limit !== undefined;
    const hasSkip = skip !== undefined;
    let values = [className];
    const where = buildWhereClause({
      schema,
      query,
      index: 2
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const limitPattern = hasLimit ? `LIMIT $${values.length + 1}` : '';

    if (hasLimit) {
      values.push(limit);
    }

    const skipPattern = hasSkip ? `OFFSET $${values.length + 1}` : '';

    if (hasSkip) {
      values.push(skip);
    }

    let sortPattern = '';

    if (sort) {
      const sortCopy = sort;
      const sorting = Object.keys(sort).map(key => {
        const transformKey = transformDotFieldToComponents(key).join('->'); // Using $idx pattern gives:  non-integer constant in ORDER BY

        if (sortCopy[key] === 1) {
          return `${transformKey} ASC`;
        }

        return `${transformKey} DESC`;
      }).join();
      sortPattern = sort !== undefined && Object.keys(sort).length > 0 ? `ORDER BY ${sorting}` : '';
    }

    if (where.sorts && Object.keys(where.sorts).length > 0) {
      sortPattern = `ORDER BY ${where.sorts.join()}`;
    }

    let columns = '*';

    if (keys) {
      // Exclude empty keys
      // Replace ACL by it's keys
      keys = keys.reduce((memo, key) => {
        if (key === 'ACL') {
          memo.push('_rperm');
          memo.push('_wperm');
        } else if (key.length > 0) {
          memo.push(key);
        }

        return memo;
      }, []);
      columns = keys.map((key, index) => {
        if (key === '$score') {
          return `ts_rank_cd(to_tsvector($${2}, $${3}:name), to_tsquery($${4}, $${5}), 32) as score`;
        }

        return `$${index + values.length + 1}:name`;
      }).join();
      values = values.concat(keys);
    }

    const qs = `SELECT ${columns} FROM $1:name ${wherePattern} ${sortPattern} ${limitPattern} ${skipPattern}`;
    debug(qs, values);
    return this._client.any(qs, values).catch(error => {
      // Query on non existing table, don't crash
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }

      return [];
    }).then(results => results.map(object => this.postgresObjectToParseObject(className, object, schema)));
  } // Converts from a postgres-format object to a REST-format object.
  // Does not strip out anything based on a lack of authentication.


  postgresObjectToParseObject(className, object, schema) {
    Object.keys(schema.fields).forEach(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer' && object[fieldName]) {
        object[fieldName] = {
          objectId: object[fieldName],
          __type: 'Pointer',
          className: schema.fields[fieldName].targetClass
        };
      }

      if (schema.fields[fieldName].type === 'Relation') {
        object[fieldName] = {
          __type: 'Relation',
          className: schema.fields[fieldName].targetClass
        };
      }

      if (object[fieldName] && schema.fields[fieldName].type === 'GeoPoint') {
        object[fieldName] = {
          __type: 'GeoPoint',
          latitude: object[fieldName].y,
          longitude: object[fieldName].x
        };
      }

      if (object[fieldName] && schema.fields[fieldName].type === 'Polygon') {
        let coords = object[fieldName];
        coords = coords.substr(2, coords.length - 4).split('),(');
        coords = coords.map(point => {
          return [parseFloat(point.split(',')[1]), parseFloat(point.split(',')[0])];
        });
        object[fieldName] = {
          __type: 'Polygon',
          coordinates: coords
        };
      }

      if (object[fieldName] && schema.fields[fieldName].type === 'File') {
        object[fieldName] = {
          __type: 'File',
          name: object[fieldName]
        };
      }
    }); //TODO: remove this reliance on the mongo format. DB adapter shouldn't know there is a difference between created at and any other date field.

    if (object.createdAt) {
      object.createdAt = object.createdAt.toISOString();
    }

    if (object.updatedAt) {
      object.updatedAt = object.updatedAt.toISOString();
    }

    if (object.expiresAt) {
      object.expiresAt = {
        __type: 'Date',
        iso: object.expiresAt.toISOString()
      };
    }

    if (object._email_verify_token_expires_at) {
      object._email_verify_token_expires_at = {
        __type: 'Date',
        iso: object._email_verify_token_expires_at.toISOString()
      };
    }

    if (object._account_lockout_expires_at) {
      object._account_lockout_expires_at = {
        __type: 'Date',
        iso: object._account_lockout_expires_at.toISOString()
      };
    }

    if (object._perishable_token_expires_at) {
      object._perishable_token_expires_at = {
        __type: 'Date',
        iso: object._perishable_token_expires_at.toISOString()
      };
    }

    if (object._password_changed_at) {
      object._password_changed_at = {
        __type: 'Date',
        iso: object._password_changed_at.toISOString()
      };
    }

    for (const fieldName in object) {
      if (object[fieldName] === null) {
        delete object[fieldName];
      }

      if (object[fieldName] instanceof Date) {
        object[fieldName] = {
          __type: 'Date',
          iso: object[fieldName].toISOString()
        };
      }
    }

    return object;
  } // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.


  ensureUniqueness(className, schema, fieldNames) {
    // Use the same name for every ensureUniqueness attempt, because postgres
    // Will happily create the same index with multiple names.
    const constraintName = `unique_${fieldNames.sort().join('_')}`;
    const constraintPatterns = fieldNames.map((fieldName, index) => `$${index + 3}:name`);
    const qs = `ALTER TABLE $1:name ADD CONSTRAINT $2:name UNIQUE (${constraintPatterns.join()})`;
    return this._client.none(qs, [className, constraintName, ...fieldNames]).catch(error => {
      if (error.code === PostgresDuplicateRelationError && error.message.includes(constraintName)) {// Index already exists. Ignore error.
      } else if (error.code === PostgresUniqueIndexViolationError && error.message.includes(constraintName)) {
        // Cast the error into the proper parse error
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      } else {
        throw error;
      }
    });
  } // Executes a count.


  count(className, schema, query) {
    debug('count', className, query);
    const values = [className];
    const where = buildWhereClause({
      schema,
      query,
      index: 2
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const qs = `SELECT count(*) FROM $1:name ${wherePattern}`;
    return this._client.one(qs, values, a => +a.count).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }

      return 0;
    });
  }

  distinct(className, schema, query, fieldName) {
    debug('distinct', className, query);
    let field = fieldName;
    let column = fieldName;
    const isNested = fieldName.indexOf('.') >= 0;

    if (isNested) {
      field = transformDotFieldToComponents(fieldName).join('->');
      column = fieldName.split('.')[0];
    }

    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const isPointerField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    const values = [field, column, className];
    const where = buildWhereClause({
      schema,
      query,
      index: 4
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const transformer = isArrayField ? 'jsonb_array_elements' : 'ON';
    let qs = `SELECT DISTINCT ${transformer}($1:name) $2:name FROM $3:name ${wherePattern}`;

    if (isNested) {
      qs = `SELECT DISTINCT ${transformer}($1:raw) $2:raw FROM $3:name ${wherePattern}`;
    }

    debug(qs, values);
    return this._client.any(qs, values).catch(error => {
      if (error.code === PostgresMissingColumnError) {
        return [];
      }

      throw error;
    }).then(results => {
      if (!isNested) {
        results = results.filter(object => object[field] !== null);
        return results.map(object => {
          if (!isPointerField) {
            return object[field];
          }

          return {
            __type: 'Pointer',
            className: schema.fields[fieldName].targetClass,
            objectId: object[field]
          };
        });
      }

      const child = fieldName.split('.')[1];
      return results.map(object => object[column][child]);
    }).then(results => results.map(object => this.postgresObjectToParseObject(className, object, schema)));
  }

  aggregate(className, schema, pipeline) {
    debug('aggregate', className, pipeline);
    const values = [className];
    let index = 2;
    let columns = [];
    let countField = null;
    let groupValues = null;
    let wherePattern = '';
    let limitPattern = '';
    let skipPattern = '';
    let sortPattern = '';
    let groupPattern = '';

    for (let i = 0; i < pipeline.length; i += 1) {
      const stage = pipeline[i];

      if (stage.$group) {
        for (const field in stage.$group) {
          const value = stage.$group[field];

          if (value === null || value === undefined) {
            continue;
          }

          if (field === '_id' && typeof value === 'string' && value !== '') {
            columns.push(`$${index}:name AS "objectId"`);
            groupPattern = `GROUP BY $${index}:name`;
            values.push(transformAggregateField(value));
            index += 1;
            continue;
          }

          if (field === '_id' && typeof value === 'object' && Object.keys(value).length !== 0) {
            groupValues = value;
            const groupByFields = [];

            for (const alias in value) {
              const operation = Object.keys(value[alias])[0];
              const source = transformAggregateField(value[alias][operation]);

              if (mongoAggregateToPostgres[operation]) {
                if (!groupByFields.includes(`"${source}"`)) {
                  groupByFields.push(`"${source}"`);
                }

                columns.push(`EXTRACT(${mongoAggregateToPostgres[operation]} FROM $${index}:name AT TIME ZONE 'UTC') AS $${index + 1}:name`);
                values.push(source, alias);
                index += 2;
              }
            }

            groupPattern = `GROUP BY $${index}:raw`;
            values.push(groupByFields.join());
            index += 1;
            continue;
          }

          if (value.$sum) {
            if (typeof value.$sum === 'string') {
              columns.push(`SUM($${index}:name) AS $${index + 1}:name`);
              values.push(transformAggregateField(value.$sum), field);
              index += 2;
            } else {
              countField = field;
              columns.push(`COUNT(*) AS $${index}:name`);
              values.push(field);
              index += 1;
            }
          }

          if (value.$max) {
            columns.push(`MAX($${index}:name) AS $${index + 1}:name`);
            values.push(transformAggregateField(value.$max), field);
            index += 2;
          }

          if (value.$min) {
            columns.push(`MIN($${index}:name) AS $${index + 1}:name`);
            values.push(transformAggregateField(value.$min), field);
            index += 2;
          }

          if (value.$avg) {
            columns.push(`AVG($${index}:name) AS $${index + 1}:name`);
            values.push(transformAggregateField(value.$avg), field);
            index += 2;
          }
        }
      } else {
        columns.push('*');
      }

      if (stage.$project) {
        if (columns.includes('*')) {
          columns = [];
        }

        for (const field in stage.$project) {
          const value = stage.$project[field];

          if (value === 1 || value === true) {
            columns.push(`$${index}:name`);
            values.push(field);
            index += 1;
          }
        }
      }

      if (stage.$match) {
        const patterns = [];
        const orOrAnd = stage.$match.hasOwnProperty('$or') ? ' OR ' : ' AND ';

        if (stage.$match.$or) {
          const collapse = {};
          stage.$match.$or.forEach(element => {
            for (const key in element) {
              collapse[key] = element[key];
            }
          });
          stage.$match = collapse;
        }

        for (const field in stage.$match) {
          const value = stage.$match[field];
          const matchPatterns = [];
          Object.keys(ParseToPosgresComparator).forEach(cmp => {
            if (value[cmp]) {
              const pgComparator = ParseToPosgresComparator[cmp];
              matchPatterns.push(`$${index}:name ${pgComparator} $${index + 1}`);
              values.push(field, toPostgresValue(value[cmp]));
              index += 2;
            }
          });

          if (matchPatterns.length > 0) {
            patterns.push(`(${matchPatterns.join(' AND ')})`);
          }

          if (schema.fields[field] && schema.fields[field].type && matchPatterns.length === 0) {
            patterns.push(`$${index}:name = $${index + 1}`);
            values.push(field, value);
            index += 2;
          }
        }

        wherePattern = patterns.length > 0 ? `WHERE ${patterns.join(` ${orOrAnd} `)}` : '';
      }

      if (stage.$limit) {
        limitPattern = `LIMIT $${index}`;
        values.push(stage.$limit);
        index += 1;
      }

      if (stage.$skip) {
        skipPattern = `OFFSET $${index}`;
        values.push(stage.$skip);
        index += 1;
      }

      if (stage.$sort) {
        const sort = stage.$sort;
        const keys = Object.keys(sort);
        const sorting = keys.map(key => {
          const transformer = sort[key] === 1 ? 'ASC' : 'DESC';
          const order = `$${index}:name ${transformer}`;
          index += 1;
          return order;
        }).join();
        values.push(...keys);
        sortPattern = sort !== undefined && sorting.length > 0 ? `ORDER BY ${sorting}` : '';
      }
    }

    const qs = `SELECT ${columns.join()} FROM $1:name ${wherePattern} ${sortPattern} ${limitPattern} ${skipPattern} ${groupPattern}`;
    debug(qs, values);
    return this._client.map(qs, values, a => this.postgresObjectToParseObject(className, a, schema)).then(results => {
      results.forEach(result => {
        if (!result.hasOwnProperty('objectId')) {
          result.objectId = null;
        }

        if (groupValues) {
          result.objectId = {};

          for (const key in groupValues) {
            result.objectId[key] = result[key];
            delete result[key];
          }
        }

        if (countField) {
          result[countField] = parseInt(result[countField], 10);
        }
      });
      return results;
    });
  }

  performInitialization({
    VolatileClassesSchemas
  }) {
    // TODO: This method needs to be rewritten to make proper use of connections (@vitaly-t)
    debug('performInitialization');
    const promises = VolatileClassesSchemas.map(schema => {
      return this.createTable(schema.className, schema).catch(err => {
        if (err.code === PostgresDuplicateRelationError || err.code === _node.default.Error.INVALID_CLASS_NAME) {
          return Promise.resolve();
        }

        throw err;
      }).then(() => this.schemaUpgrade(schema.className, schema));
    });
    return Promise.all(promises).then(() => {
      return this._client.tx('perform-initialization', t => {
        return t.batch([t.none(_sql.default.misc.jsonObjectSetKeys), t.none(_sql.default.array.add), t.none(_sql.default.array.addUnique), t.none(_sql.default.array.remove), t.none(_sql.default.array.containsAll), t.none(_sql.default.array.containsAllRegex), t.none(_sql.default.array.contains)]);
      });
    }).then(data => {
      debug(`initializationDone in ${data.duration}`);
    }).catch(error => {
      /* eslint-disable no-console */
      console.error(error);
    });
  }

  createIndexes(className, indexes, conn) {
    return (conn || this._client).tx(t => t.batch(indexes.map(i => {
      return t.none('CREATE INDEX $1:name ON $2:name ($3:name)', [i.name, className, i.key]);
    })));
  }

  createIndexesIfNeeded(className, fieldName, type, conn) {
    return (conn || this._client).none('CREATE INDEX $1:name ON $2:name ($3:name)', [fieldName, className, type]);
  }

  dropIndexes(className, indexes, conn) {
    const queries = indexes.map(i => ({
      query: 'DROP INDEX $1:name',
      values: i
    }));
    return (conn || this._client).tx(t => t.none(this._pgp.helpers.concat(queries)));
  }

  getIndexes(className) {
    const qs = 'SELECT * FROM pg_indexes WHERE tablename = ${className}';
    return this._client.any(qs, {
      className
    });
  }

  updateSchemaWithIndexes() {
    return Promise.resolve();
  }

}

exports.PostgresStorageAdapter = PostgresStorageAdapter;

function convertPolygonToSQL(polygon) {
  if (polygon.length < 3) {
    throw new _node.default.Error(_node.default.Error.INVALID_JSON, `Polygon must have at least 3 values`);
  }

  if (polygon[0][0] !== polygon[polygon.length - 1][0] || polygon[0][1] !== polygon[polygon.length - 1][1]) {
    polygon.push(polygon[0]);
  }

  const unique = polygon.filter((item, index, ar) => {
    let foundIndex = -1;

    for (let i = 0; i < ar.length; i += 1) {
      const pt = ar[i];

      if (pt[0] === item[0] && pt[1] === item[1]) {
        foundIndex = i;
        break;
      }
    }

    return foundIndex === index;
  });

  if (unique.length < 3) {
    throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'GeoJSON: Loop must have at least 3 different vertices');
  }

  const points = polygon.map(point => {
    _node.default.GeoPoint._validate(parseFloat(point[1]), parseFloat(point[0]));

    return `(${point[1]}, ${point[0]})`;
  }).join(', ');
  return `(${points})`;
}

function removeWhiteSpace(regex) {
  if (!regex.endsWith('\n')) {
    regex += '\n';
  } // remove non escaped comments


  return regex.replace(/([^\\])#.*\n/gim, '$1') // remove lines starting with a comment
  .replace(/^#.*\n/gim, '') // remove non escaped whitespace
  .replace(/([^\\])\s+/gim, '$1') // remove whitespace at the beginning of a line
  .replace(/^\s+/, '').trim();
}

function processRegexPattern(s) {
  if (s && s.startsWith('^')) {
    // regex for startsWith
    return '^' + literalizeRegexPart(s.slice(1));
  } else if (s && s.endsWith('$')) {
    // regex for endsWith
    return literalizeRegexPart(s.slice(0, s.length - 1)) + '$';
  } // regex for contains


  return literalizeRegexPart(s);
}

function isStartsWithRegex(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('^')) {
    return false;
  }

  const matches = value.match(/\^\\Q.*\\E/);
  return !!matches;
}

function isAllValuesRegexOrNone(values) {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return true;
  }

  const firstValuesIsRegex = isStartsWithRegex(values[0].$regex);

  if (values.length === 1) {
    return firstValuesIsRegex;
  }

  for (let i = 1, length = values.length; i < length; ++i) {
    if (firstValuesIsRegex !== isStartsWithRegex(values[i].$regex)) {
      return false;
    }
  }

  return true;
}

function isAnyValueRegexStartsWith(values) {
  return values.some(function (value) {
    return isStartsWithRegex(value.$regex);
  });
}

function createLiteralRegex(remaining) {
  return remaining.split('').map(c => {
    const regex = (0, _xregexp.XRegExp)('[0-9 ]|\\p{L}');

    if (c.match(regex) !== null) {
      // don't escape alphanumeric characters
      return c;
    } // escape everything else (single quotes with single quotes, everything else with a backslash)


    return c === `'` ? `''` : `\\${c}`;
  }).join('');
}

function literalizeRegexPart(s) {
  const matcher1 = /\\Q((?!\\E).*)\\E$/;
  const result1 = s.match(matcher1);

  if (result1 && result1.length > 1 && result1.index > -1) {
    // process regex that has a beginning and an end specified for the literal text
    const prefix = s.substr(0, result1.index);
    const remaining = result1[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  } // process regex that has a beginning specified for the literal text


  const matcher2 = /\\Q((?!\\E).*)$/;
  const result2 = s.match(matcher2);

  if (result2 && result2.length > 1 && result2.index > -1) {
    const prefix = s.substr(0, result2.index);
    const remaining = result2[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  } // remove all instances of \Q and \E from the remaining text & escape single quotes


  const value = s.replace(/([^\\])(\\E)/, '$1').replace(/([^\\])(\\Q)/, '$1').replace(/^\\E/, '').replace(/^\\Q/, '').replace(/([^'])'/, `$1''`).replace(/^'([^'])/, `''$1`);
  return value;
}

var GeoPointCoder = {
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'GeoPoint';
  }

};
var _default = PostgresStorageAdapter;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXIuanMiXSwibmFtZXMiOlsiUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVDb2x1bW5FcnJvciIsIlBvc3RncmVzTWlzc2luZ0NvbHVtbkVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVPYmplY3RFcnJvciIsIlBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvciIsIlBvc3RncmVzVHJhbnNhY3Rpb25BYm9ydGVkRXJyb3IiLCJsb2dnZXIiLCJyZXF1aXJlIiwiZGVidWciLCJhcmdzIiwiYXJndW1lbnRzIiwiY29uY2F0Iiwic2xpY2UiLCJsZW5ndGgiLCJsb2ciLCJnZXRMb2dnZXIiLCJhcHBseSIsInBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlIiwidHlwZSIsImNvbnRlbnRzIiwiSlNPTiIsInN0cmluZ2lmeSIsIlBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvciIsIiRndCIsIiRsdCIsIiRndGUiLCIkbHRlIiwibW9uZ29BZ2dyZWdhdGVUb1Bvc3RncmVzIiwiJGRheU9mTW9udGgiLCIkZGF5T2ZXZWVrIiwiJGRheU9mWWVhciIsIiRpc29EYXlPZldlZWsiLCIkaXNvV2Vla1llYXIiLCIkaG91ciIsIiRtaW51dGUiLCIkc2Vjb25kIiwiJG1pbGxpc2Vjb25kIiwiJG1vbnRoIiwiJHdlZWsiLCIkeWVhciIsInRvUG9zdGdyZXNWYWx1ZSIsInZhbHVlIiwiX190eXBlIiwiaXNvIiwibmFtZSIsInRyYW5zZm9ybVZhbHVlIiwib2JqZWN0SWQiLCJlbXB0eUNMUFMiLCJPYmplY3QiLCJmcmVlemUiLCJmaW5kIiwiZ2V0IiwiY3JlYXRlIiwidXBkYXRlIiwiZGVsZXRlIiwiYWRkRmllbGQiLCJkZWZhdWx0Q0xQUyIsInRvUGFyc2VTY2hlbWEiLCJzY2hlbWEiLCJjbGFzc05hbWUiLCJmaWVsZHMiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3dwZXJtIiwiX3JwZXJtIiwiY2xwcyIsImNsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImluZGV4ZXMiLCJ0b1Bvc3RncmVzU2NoZW1hIiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJoYW5kbGVEb3RGaWVsZHMiLCJvYmplY3QiLCJrZXlzIiwiZm9yRWFjaCIsImZpZWxkTmFtZSIsImluZGV4T2YiLCJjb21wb25lbnRzIiwic3BsaXQiLCJmaXJzdCIsInNoaWZ0IiwiY3VycmVudE9iaiIsIm5leHQiLCJfX29wIiwidW5kZWZpbmVkIiwidHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMiLCJtYXAiLCJjbXB0IiwiaW5kZXgiLCJ0cmFuc2Zvcm1Eb3RGaWVsZCIsImpvaW4iLCJ0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCIsInN1YnN0ciIsInZhbGlkYXRlS2V5cyIsImtleSIsImluY2x1ZGVzIiwiUGFyc2UiLCJFcnJvciIsIklOVkFMSURfTkVTVEVEX0tFWSIsImpvaW5UYWJsZXNGb3JTY2hlbWEiLCJsaXN0IiwiZmllbGQiLCJwdXNoIiwiYnVpbGRXaGVyZUNsYXVzZSIsInF1ZXJ5IiwicGF0dGVybnMiLCJ2YWx1ZXMiLCJzb3J0cyIsImlzQXJyYXlGaWVsZCIsImluaXRpYWxQYXR0ZXJuc0xlbmd0aCIsImZpZWxkVmFsdWUiLCIkZXhpc3RzIiwiJGluIiwiaW5QYXR0ZXJucyIsImxpc3RFbGVtIiwiJHJlZ2V4IiwiTUFYX0lOVF9QTFVTX09ORSIsImNsYXVzZXMiLCJjbGF1c2VWYWx1ZXMiLCJzdWJRdWVyeSIsImNsYXVzZSIsInBhdHRlcm4iLCJvck9yQW5kIiwibm90IiwiJG5lIiwiJGVxIiwiaXNJbk9yTmluIiwiQXJyYXkiLCJpc0FycmF5IiwiJG5pbiIsImFsbG93TnVsbCIsImxpc3RJbmRleCIsImNyZWF0ZUNvbnN0cmFpbnQiLCJiYXNlQXJyYXkiLCJub3RJbiIsIl8iLCJmbGF0TWFwIiwiZWx0IiwiSU5WQUxJRF9KU09OIiwiJGFsbCIsImlzQW55VmFsdWVSZWdleFN0YXJ0c1dpdGgiLCJpc0FsbFZhbHVlc1JlZ2V4T3JOb25lIiwiaSIsInByb2Nlc3NSZWdleFBhdHRlcm4iLCJzdWJzdHJpbmciLCIkY29udGFpbmVkQnkiLCJhcnIiLCIkdGV4dCIsInNlYXJjaCIsIiRzZWFyY2giLCJsYW5ndWFnZSIsIiR0ZXJtIiwiJGxhbmd1YWdlIiwiJGNhc2VTZW5zaXRpdmUiLCIkZGlhY3JpdGljU2Vuc2l0aXZlIiwiJG5lYXJTcGhlcmUiLCJwb2ludCIsImRpc3RhbmNlIiwiJG1heERpc3RhbmNlIiwiZGlzdGFuY2VJbktNIiwibG9uZ2l0dWRlIiwibGF0aXR1ZGUiLCIkd2l0aGluIiwiJGJveCIsImJveCIsImxlZnQiLCJib3R0b20iLCJyaWdodCIsInRvcCIsIiRnZW9XaXRoaW4iLCIkY2VudGVyU3BoZXJlIiwiY2VudGVyU3BoZXJlIiwiR2VvUG9pbnQiLCJHZW9Qb2ludENvZGVyIiwiaXNWYWxpZEpTT04iLCJfdmFsaWRhdGUiLCJpc05hTiIsIiRwb2x5Z29uIiwicG9seWdvbiIsInBvaW50cyIsImNvb3JkaW5hdGVzIiwiJGdlb0ludGVyc2VjdHMiLCIkcG9pbnQiLCJyZWdleCIsIm9wZXJhdG9yIiwib3B0cyIsIiRvcHRpb25zIiwicmVtb3ZlV2hpdGVTcGFjZSIsImNvbnZlcnRQb2x5Z29uVG9TUUwiLCJjbXAiLCJwZ0NvbXBhcmF0b3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwiUG9zdGdyZXNTdG9yYWdlQWRhcHRlciIsImNvbnN0cnVjdG9yIiwidXJpIiwiY29sbGVjdGlvblByZWZpeCIsImRhdGFiYXNlT3B0aW9ucyIsIl9jb2xsZWN0aW9uUHJlZml4IiwiY2xpZW50IiwicGdwIiwiX2NsaWVudCIsIl9wZ3AiLCJjYW5Tb3J0T25Kb2luVGFibGVzIiwiaGFuZGxlU2h1dGRvd24iLCIkcG9vbCIsImVuZCIsIl9lbnN1cmVTY2hlbWFDb2xsZWN0aW9uRXhpc3RzIiwiY29ubiIsIm5vbmUiLCJjYXRjaCIsImVycm9yIiwiY29kZSIsImNsYXNzRXhpc3RzIiwib25lIiwiYSIsImV4aXN0cyIsInNldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsIkNMUHMiLCJzZWxmIiwidGFzayIsInQiLCJzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdCIsInN1Ym1pdHRlZEluZGV4ZXMiLCJleGlzdGluZ0luZGV4ZXMiLCJQcm9taXNlIiwicmVzb2x2ZSIsIl9pZF8iLCJfaWQiLCJkZWxldGVkSW5kZXhlcyIsImluc2VydGVkSW5kZXhlcyIsIklOVkFMSURfUVVFUlkiLCJoYXNPd25Qcm9wZXJ0eSIsInR4IiwiY3JlYXRlSW5kZXhlcyIsImRyb3BJbmRleGVzIiwiY3JlYXRlQ2xhc3MiLCJxMSIsImNyZWF0ZVRhYmxlIiwicTIiLCJxMyIsImJhdGNoIiwidGhlbiIsImVyciIsImRhdGEiLCJyZXN1bHQiLCJkZXRhaWwiLCJEVVBMSUNBVEVfVkFMVUUiLCJ2YWx1ZXNBcnJheSIsInBhdHRlcm5zQXJyYXkiLCJhc3NpZ24iLCJfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQiLCJfZW1haWxfdmVyaWZ5X3Rva2VuIiwiX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0IiwiX2ZhaWxlZF9sb2dpbl9jb3VudCIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwicmVsYXRpb25zIiwicGFyc2VUeXBlIiwicXMiLCJqb2luVGFibGUiLCJzY2hlbWFVcGdyYWRlIiwiY29sdW1ucyIsImNvbHVtbl9uYW1lIiwibmV3Q29sdW1ucyIsImZpbHRlciIsIml0ZW0iLCJhZGRGaWVsZElmTm90RXhpc3RzIiwicG9zdGdyZXNUeXBlIiwiYW55IiwicGF0aCIsImRlbGV0ZUNsYXNzIiwib3BlcmF0aW9ucyIsImhlbHBlcnMiLCJkZWxldGVBbGxDbGFzc2VzIiwibm93IiwiRGF0ZSIsImdldFRpbWUiLCJyZXN1bHRzIiwiam9pbnMiLCJyZWR1Y2UiLCJjbGFzc2VzIiwicXVlcmllcyIsImRlbGV0ZUZpZWxkcyIsImZpZWxkTmFtZXMiLCJpZHgiLCJnZXRBbGxDbGFzc2VzIiwicm93IiwiZ2V0Q2xhc3MiLCJjcmVhdGVPYmplY3QiLCJjb2x1bW5zQXJyYXkiLCJnZW9Qb2ludHMiLCJhdXRoRGF0YU1hdGNoIiwibWF0Y2giLCJwcm92aWRlciIsInBvcCIsImluaXRpYWxWYWx1ZXMiLCJ2YWwiLCJ0ZXJtaW5hdGlvbiIsImdlb1BvaW50c0luamVjdHMiLCJsIiwiY29sdW1uc1BhdHRlcm4iLCJjb2wiLCJ2YWx1ZXNQYXR0ZXJuIiwib3BzIiwidW5kZXJseWluZ0Vycm9yIiwiY29uc3RyYWludCIsIm1hdGNoZXMiLCJ1c2VySW5mbyIsImR1cGxpY2F0ZWRfZmllbGQiLCJkZWxldGVPYmplY3RzQnlRdWVyeSIsIndoZXJlIiwiY291bnQiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiZmluZE9uZUFuZFVwZGF0ZSIsInVwZGF0ZU9iamVjdHNCeVF1ZXJ5IiwidXBkYXRlUGF0dGVybnMiLCJvcmlnaW5hbFVwZGF0ZSIsImRvdE5vdGF0aW9uT3B0aW9ucyIsImdlbmVyYXRlIiwianNvbmIiLCJsYXN0S2V5IiwiZmllbGROYW1lSW5kZXgiLCJzdHIiLCJhbW91bnQiLCJvYmplY3RzIiwia2V5c1RvSW5jcmVtZW50IiwiayIsImluY3JlbWVudFBhdHRlcm5zIiwiYyIsImtleXNUb0RlbGV0ZSIsImRlbGV0ZVBhdHRlcm5zIiwicCIsInVwZGF0ZU9iamVjdCIsImV4cGVjdGVkVHlwZSIsImJ1aWxkU1FMQXJyYXkiLCJlbGVtZW50Iiwic3FsIiwicmVqZWN0Iiwid2hlcmVDbGF1c2UiLCJ1cHNlcnRPbmVPYmplY3QiLCJjcmVhdGVWYWx1ZSIsInNraXAiLCJsaW1pdCIsInNvcnQiLCJoYXNMaW1pdCIsImhhc1NraXAiLCJ3aGVyZVBhdHRlcm4iLCJsaW1pdFBhdHRlcm4iLCJza2lwUGF0dGVybiIsInNvcnRQYXR0ZXJuIiwic29ydENvcHkiLCJzb3J0aW5nIiwidHJhbnNmb3JtS2V5IiwibWVtbyIsInBvc3RncmVzT2JqZWN0VG9QYXJzZU9iamVjdCIsInRhcmdldENsYXNzIiwieSIsIngiLCJjb29yZHMiLCJwYXJzZUZsb2F0IiwiY3JlYXRlZEF0IiwidG9JU09TdHJpbmciLCJ1cGRhdGVkQXQiLCJleHBpcmVzQXQiLCJlbnN1cmVVbmlxdWVuZXNzIiwiY29uc3RyYWludE5hbWUiLCJjb25zdHJhaW50UGF0dGVybnMiLCJtZXNzYWdlIiwiZGlzdGluY3QiLCJjb2x1bW4iLCJpc05lc3RlZCIsImlzUG9pbnRlckZpZWxkIiwidHJhbnNmb3JtZXIiLCJjaGlsZCIsImFnZ3JlZ2F0ZSIsInBpcGVsaW5lIiwiY291bnRGaWVsZCIsImdyb3VwVmFsdWVzIiwiZ3JvdXBQYXR0ZXJuIiwic3RhZ2UiLCIkZ3JvdXAiLCJncm91cEJ5RmllbGRzIiwiYWxpYXMiLCJvcGVyYXRpb24iLCJzb3VyY2UiLCIkc3VtIiwiJG1heCIsIiRtaW4iLCIkYXZnIiwiJHByb2plY3QiLCIkbWF0Y2giLCIkb3IiLCJjb2xsYXBzZSIsIm1hdGNoUGF0dGVybnMiLCIkbGltaXQiLCIkc2tpcCIsIiRzb3J0Iiwib3JkZXIiLCJwYXJzZUludCIsInBlcmZvcm1Jbml0aWFsaXphdGlvbiIsIlZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMiLCJwcm9taXNlcyIsIklOVkFMSURfQ0xBU1NfTkFNRSIsImFsbCIsIm1pc2MiLCJqc29uT2JqZWN0U2V0S2V5cyIsImFycmF5IiwiYWRkIiwiYWRkVW5pcXVlIiwicmVtb3ZlIiwiY29udGFpbnNBbGwiLCJjb250YWluc0FsbFJlZ2V4IiwiY29udGFpbnMiLCJkdXJhdGlvbiIsImNvbnNvbGUiLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJnZXRJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJ1bmlxdWUiLCJhciIsImZvdW5kSW5kZXgiLCJwdCIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsImVuZHNXaXRoIiwicmVwbGFjZSIsInRyaW0iLCJzIiwic3RhcnRzV2l0aCIsImxpdGVyYWxpemVSZWdleFBhcnQiLCJpc1N0YXJ0c1dpdGhSZWdleCIsImZpcnN0VmFsdWVzSXNSZWdleCIsInNvbWUiLCJjcmVhdGVMaXRlcmFsUmVnZXgiLCJyZW1haW5pbmciLCJtYXRjaGVyMSIsInJlc3VsdDEiLCJwcmVmaXgiLCJtYXRjaGVyMiIsInJlc3VsdDIiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFDQTs7QUFFQTs7QUFFQTs7QUFDQTs7QUFFQTs7QUFpQkE7Ozs7Ozs7O0FBZkEsTUFBTUEsaUNBQWlDLEdBQUcsT0FBMUM7QUFDQSxNQUFNQyw4QkFBOEIsR0FBRyxPQUF2QztBQUNBLE1BQU1DLDRCQUE0QixHQUFHLE9BQXJDO0FBQ0EsTUFBTUMsMEJBQTBCLEdBQUcsT0FBbkM7QUFDQSxNQUFNQyw0QkFBNEIsR0FBRyxPQUFyQztBQUNBLE1BQU1DLGlDQUFpQyxHQUFHLE9BQTFDO0FBQ0EsTUFBTUMsK0JBQStCLEdBQUcsT0FBeEM7O0FBQ0EsTUFBTUMsTUFBTSxHQUFHQyxPQUFPLENBQUMsaUJBQUQsQ0FBdEI7O0FBRUEsTUFBTUMsS0FBSyxHQUFHLFVBQVMsR0FBR0MsSUFBWixFQUF1QjtBQUNuQ0EsRUFBQUEsSUFBSSxHQUFHLENBQUMsU0FBU0MsU0FBUyxDQUFDLENBQUQsQ0FBbkIsRUFBd0JDLE1BQXhCLENBQStCRixJQUFJLENBQUNHLEtBQUwsQ0FBVyxDQUFYLEVBQWNILElBQUksQ0FBQ0ksTUFBbkIsQ0FBL0IsQ0FBUDtBQUNBLFFBQU1DLEdBQUcsR0FBR1IsTUFBTSxDQUFDUyxTQUFQLEVBQVo7QUFDQUQsRUFBQUEsR0FBRyxDQUFDTixLQUFKLENBQVVRLEtBQVYsQ0FBZ0JGLEdBQWhCLEVBQXFCTCxJQUFyQjtBQUNELENBSkQ7O0FBU0EsTUFBTVEsdUJBQXVCLEdBQUdDLElBQUksSUFBSTtBQUN0QyxVQUFRQSxJQUFJLENBQUNBLElBQWI7QUFDRSxTQUFLLFFBQUw7QUFDRSxhQUFPLE1BQVA7O0FBQ0YsU0FBSyxNQUFMO0FBQ0UsYUFBTywwQkFBUDs7QUFDRixTQUFL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LEtBQUssSUFBdkMsSUFBK0NBLEtBQUssQ0FBQ0MsTUFBTixLQUFpQixVQURsRTtBQUdEOztBQUxpQixDQUFwQjtlQVFlb0osc0IiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBAZmxvd1xuaW1wb3J0IHsgY3JlYXRlQ2xpZW50IH0gZnJvbSAnLi9Qb3N0Z3Jlc0NsaWVudCc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBzcWwgZnJvbSAnLi9zcWwnO1xuLy92YXIgWFJlZ0V4cCA9IHJlcXVpcmUoJ3hyZWdleHAnKTtcbmltcG9ydCB7WFJlZ0V4cH0gZnJvbSBcInhyZWdleHBcIjtcblxuY29uc3QgUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yID0gJzQyUDAxJztcbmNvbnN0IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvciA9ICc0MlAwNyc7XG5jb25zdCBQb3N0Z3Jlc0R1cGxpY2F0ZUNvbHVtbkVycm9yID0gJzQyNzAxJztcbmNvbnN0IFBvc3RncmVzTWlzc2luZ0NvbHVtbkVycm9yID0gJzQyNzAzJztcbmNvbnN0IFBvc3RncmVzRHVwbGljYXRlT2JqZWN0RXJyb3IgPSAnNDI3MTAnO1xuY29uc3QgUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yID0gJzIzNTA1JztcbmNvbnN0IFBvc3RncmVzVHJhbnNhY3Rpb25BYm9ydGVkRXJyb3IgPSAnMjVQMDInO1xuY29uc3QgbG9nZ2VyID0gcmVxdWlyZSgnLi4vLi4vLi4vbG9nZ2VyJyk7XG5cbmNvbnN0IGRlYnVnID0gZnVuY3Rpb24oLi4uYXJnczogYW55KSB7XG4gIGFyZ3MgPSBbJ1BHOiAnICsgYXJndW1lbnRzWzBdXS5jb25jYXQoYXJncy5zbGljZSgxLCBhcmdzLmxlbmd0aCkpO1xuICBjb25zdCBsb2cgPSBsb2dnZXIuZ2V0TG9nZ2VyKCk7XG4gIGxvZy5kZWJ1Zy5hcHBseShsb2csIGFyZ3MpO1xufTtcblxuaW1wb3J0IHsgU3RvcmFnZUFkYXB0ZXIgfSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5pbXBvcnQgdHlwZSB7IFNjaGVtYVR5cGUsIFF1ZXJ5VHlwZSwgUXVlcnlPcHRpb25zIH0gZnJvbSAnLi4vU3RvcmFnZUFkYXB0ZXInO1xuXG5jb25zdCBwYXJzZVR5cGVUb1Bvc3RncmVzVHlwZSA9IHR5cGUgPT4ge1xuICBzd2l0Y2ggKHR5cGUudHlwZSkge1xuICAgIGNhc2UgJ1N0cmluZyc6XG4gICAgICByZXR1cm4gJ3RleHQnO1xuICAgIGNhc2UgJ0RhdGUnOlxuICAgICAgcmV0dXJuICd0aW1lc3RhbXAgd2l0aCB0aW1lIHpvbmUnO1xuICAgIGNhc2UgJ09iamVjdCc6XG4gICAgICByZXR1cm4gJ2pzb25iJztcbiAgICBjYXNlICdGaWxlJzpcbiAgICAgIHJldHVybiAndGV4dCc7XG4gICAgY2FzZSAnQm9vbGVhbic6XG4gICAgICByZXR1cm4gJ2Jvb2xlYW4nO1xuICAgIGNhc2UgJ1BvaW50ZXInOlxuICAgICAgcmV0dXJuICdjaGFyKDEwKSc7XG4gICAgY2FzZSAnTnVtYmVyJzpcbiAgICAgIHJldHVybiAnZG91YmxlIHByZWNpc2lvbic7XG4gICAgY2FzZSAnR2VvUG9pbnQnOlxuICAgICAgcmV0dXJuICdwb2ludCc7XG4gICAgY2FzZSAnQnl0ZXMnOlxuICAgICAgcmV0dXJuICdqc29uYic7XG4gICAgY2FzZSAnUG9seWdvbic6XG4gICAgICByZXR1cm4gJ3BvbHlnb24nO1xuICAgIGNhc2UgJ0FycmF5JzpcbiAgICAgIGlmICh0eXBlLmNvbnRlbnRzICYmIHR5cGUuY29udGVudHMudHlwZSA9PT0gJ1N0cmluZycpIHtcbiAgICAgICAgcmV0dXJuICd0ZXh0W10nO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuICdqc29uYic7XG4gICAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IGBubyB0eXBlIGZvciAke0pTT04uc3RyaW5naWZ5KHR5cGUpfSB5ZXRgO1xuICB9XG59O1xuXG5jb25zdCBQYXJzZVRvUG9zZ3Jlc0NvbXBhcmF0b3IgPSB7XG4gICRndDogJz4nLFxuICAkbHQ6ICc8JyxcbiAgJGd0ZTogJz49JyxcbiAgJGx0ZTogJzw9Jyxcbn07XG5cbmNvbnN0IG1vbmdvQWdncmVnYXRlVG9Qb3N0Z3JlcyA9IHtcbiAgJGRheU9mTW9udGg6ICdEQVknLFxuICAkZGF5T2ZXZWVrOiAnRE9XJyxcbiAgJGRheU9mWWVhcjogJ0RPWScsXG4gICRpc29EYXlPZldlZWs6ICdJU09ET1cnLFxuICAkaXNvV2Vla1llYXI6ICdJU09ZRUFSJyxcbiAgJGhvdXI6ICdIT1VSJyxcbiAgJG1pbnV0ZTogJ01JTlVURScsXG4gICRzZWNvbmQ6ICdTRUNPTkQnLFxuICAkbWlsbGlzZWNvbmQ6ICdNSUxMSVNFQ09ORFMnLFxuICAkbW9udGg6ICdNT05USCcsXG4gICR3ZWVrOiAnV0VFSycsXG4gICR5ZWFyOiAnWUVBUicsXG59O1xuXG5jb25zdCB0b1Bvc3RncmVzVmFsdWUgPSB2YWx1ZSA9PiB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnKSB7XG4gICAgaWYgKHZhbHVlLl9fdHlwZSA9PT0gJ0RhdGUnKSB7XG4gICAgICByZXR1cm4gdmFsdWUuaXNvO1xuICAgIH1cbiAgICBpZiAodmFsdWUuX190eXBlID09PSAnRmlsZScpIHtcbiAgICAgIHJldHVybiB2YWx1ZS5uYW1lO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdmFsdWU7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1WYWx1ZSA9IHZhbHVlID0+IHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICByZXR1cm4gdmFsdWUub2JqZWN0SWQ7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufTtcblxuLy8gRHVwbGljYXRlIGZyb20gdGhlbiBtb25nbyBhZGFwdGVyLi4uXG5jb25zdCBlbXB0eUNMUFMgPSBPYmplY3QuZnJlZXplKHtcbiAgZmluZDoge30sXG4gIGdldDoge30sXG4gIGNyZWF0ZToge30sXG4gIHVwZGF0ZToge30sXG4gIGRlbGV0ZToge30sXG4gIGFkZEZpZWxkOiB7fSxcbn0pO1xuXG5jb25zdCBkZWZhdWx0Q0xQUyA9IE9iamVjdC5mcmVlemUoe1xuICBmaW5kOiB7ICcqJzogdHJ1ZSB9LFxuICBnZXQ6IHsgJyonOiB0cnVlIH0sXG4gIGNyZWF0ZTogeyAnKic6IHRydWUgfSxcbiAgdXBkYXRlOiB7ICcqJzogdHJ1ZSB9LFxuICBkZWxldGU6IHsgJyonOiB0cnVlIH0sXG4gIGFkZEZpZWxkOiB7ICcqJzogdHJ1ZSB9LFxufSk7XG5cbmNvbnN0IHRvUGFyc2VTY2hlbWEgPSBzY2hlbWEgPT4ge1xuICBpZiAoc2NoZW1hLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9oYXNoZWRfcGFzc3dvcmQ7XG4gIH1cbiAgaWYgKHNjaGVtYS5maWVsZHMpIHtcbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5fd3Blcm07XG4gICAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3JwZXJtO1xuICB9XG4gIGxldCBjbHBzID0gZGVmYXVsdENMUFM7XG4gIGlmIChzY2hlbWEuY2xhc3NMZXZlbFBlcm1pc3Npb25zKSB7XG4gICAgY2xwcyA9IHsgLi4uZW1wdHlDTFBTLCAuLi5zY2hlbWEuY2xhc3NMZXZlbFBlcm1pc3Npb25zIH07XG4gIH1cbiAgbGV0IGluZGV4ZXMgPSB7fTtcbiAgaWYgKHNjaGVtYS5pbmRleGVzKSB7XG4gICAgaW5kZXhlcyA9IHsgLi4uc2NoZW1hLmluZGV4ZXMgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGNsYXNzTmFtZTogc2NoZW1hLmNsYXNzTmFtZSxcbiAgICBmaWVsZHM6IHNjaGVtYS5maWVsZHMsXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiBjbHBzLFxuICAgIGluZGV4ZXMsXG4gIH07XG59O1xuXG5jb25zdCB0b1Bvc3RncmVzU2NoZW1hID0gc2NoZW1hID0+IHtcbiAgaWYgKCFzY2hlbWEpIHtcbiAgICByZXR1cm4gc2NoZW1hO1xuICB9XG4gIHNjaGVtYS5maWVsZHMgPSBzY2hlbWEuZmllbGRzIHx8IHt9O1xuICBzY2hlbWEuZmllbGRzLl93cGVybSA9IHsgdHlwZTogJ0FycmF5JywgY29udGVudHM6IHsgdHlwZTogJ1N0cmluZycgfSB9O1xuICBzY2hlbWEuZmllbGRzLl9ycGVybSA9IHsgdHlwZTogJ0FycmF5JywgY29udGVudHM6IHsgdHlwZTogJ1N0cmluZycgfSB9O1xuICBpZiAoc2NoZW1hLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIHNjaGVtYS5maWVsZHMuX2hhc2hlZF9wYXNzd29yZCA9IHsgdHlwZTogJ1N0cmluZycgfTtcbiAgICBzY2hlbWEuZmllbGRzLl9wYXNzd29yZF9oaXN0b3J5ID0geyB0eXBlOiAnQXJyYXknIH07XG4gIH1cbiAgcmV0dXJuIHNjaGVtYTtcbn07XG5cbmNvbnN0IGhhbmRsZURvdEZpZWxkcyA9IG9iamVjdCA9PiB7XG4gIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID4gLTEpIHtcbiAgICAgIGNvbnN0IGNvbXBvbmVudHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgIGNvbnN0IGZpcnN0ID0gY29tcG9uZW50cy5zaGlmdCgpO1xuICAgICAgb2JqZWN0W2ZpcnN0XSA9IG9iamVjdFtmaXJzdF0gfHwge307XG4gICAgICBsZXQgY3VycmVudE9iaiA9IG9iamVjdFtmaXJzdF07XG4gICAgICBsZXQgbmV4dDtcbiAgICAgIGxldCB2YWx1ZSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgaWYgKHZhbHVlICYmIHZhbHVlLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIHZhbHVlID0gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgLyogZXNsaW50LWRpc2FibGUgbm8tY29uZC1hc3NpZ24gKi9cbiAgICAgIHdoaWxlICgobmV4dCA9IGNvbXBvbmVudHMuc2hpZnQoKSkpIHtcbiAgICAgICAgLyogZXNsaW50LWVuYWJsZSBuby1jb25kLWFzc2lnbiAqL1xuICAgICAgICBjdXJyZW50T2JqW25leHRdID0gY3VycmVudE9ialtuZXh0XSB8fCB7fTtcbiAgICAgICAgaWYgKGNvbXBvbmVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgY3VycmVudE9ialtuZXh0XSA9IHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIGN1cnJlbnRPYmogPSBjdXJyZW50T2JqW25leHRdO1xuICAgICAgfVxuICAgICAgZGVsZXRlIG9iamVjdFtmaWVsZE5hbWVdO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyA9IGZpZWxkTmFtZSA9PiB7XG4gIHJldHVybiBmaWVsZE5hbWUuc3BsaXQoJy4nKS5tYXAoKGNtcHQsIGluZGV4KSA9PiB7XG4gICAgaWYgKGluZGV4ID09PSAwKSB7XG4gICAgICByZXR1cm4gYFwiJHtjbXB0fVwiYDtcbiAgICB9XG4gICAgcmV0dXJuIGAnJHtjbXB0fSdgO1xuICB9KTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybURvdEZpZWxkID0gZmllbGROYW1lID0+IHtcbiAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPT09IC0xKSB7XG4gICAgcmV0dXJuIGBcIiR7ZmllbGROYW1lfVwiYDtcbiAgfVxuICBjb25zdCBjb21wb25lbnRzID0gdHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMoZmllbGROYW1lKTtcbiAgbGV0IG5hbWUgPSBjb21wb25lbnRzLnNsaWNlKDAsIGNvbXBvbmVudHMubGVuZ3RoIC0gMSkuam9pbignLT4nKTtcbiAgbmFtZSArPSAnLT4+JyArIGNvbXBvbmVudHNbY29tcG9uZW50cy5sZW5ndGggLSAxXTtcbiAgcmV0dXJuIG5hbWU7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCA9IGZpZWxkTmFtZSA9PiB7XG4gIGlmICh0eXBlb2YgZmllbGROYW1lICE9PSAnc3RyaW5nJykge1xuICAgIHJldHVybiBmaWVsZE5hbWU7XG4gIH1cbiAgaWYgKGZpZWxkTmFtZSA9PT0gJyRfY3JlYXRlZF9hdCcpIHtcbiAgICByZXR1cm4gJ2NyZWF0ZWRBdCc7XG4gIH1cbiAgaWYgKGZpZWxkTmFtZSA9PT0gJyRfdXBkYXRlZF9hdCcpIHtcbiAgICByZXR1cm4gJ3VwZGF0ZWRBdCc7XG4gIH1cbiAgcmV0dXJuIGZpZWxkTmFtZS5zdWJzdHIoMSk7XG59O1xuXG5jb25zdCB2YWxpZGF0ZUtleXMgPSBvYmplY3QgPT4ge1xuICBpZiAodHlwZW9mIG9iamVjdCA9PSAnb2JqZWN0Jykge1xuICAgIGZvciAoY29uc3Qga2V5IGluIG9iamVjdCkge1xuICAgICAgaWYgKHR5cGVvZiBvYmplY3Rba2V5XSA9PSAnb2JqZWN0Jykge1xuICAgICAgICB2YWxpZGF0ZUtleXMob2JqZWN0W2tleV0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoa2V5LmluY2x1ZGVzKCckJykgfHwga2V5LmluY2x1ZGVzKCcuJykpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfTkVTVEVEX0tFWSxcbiAgICAgICAgICBcIk5lc3RlZCBrZXlzIHNob3VsZCBub3QgY29udGFpbiB0aGUgJyQnIG9yICcuJyBjaGFyYWN0ZXJzXCJcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cbi8vIFJldHVybnMgdGhlIGxpc3Qgb2Ygam9pbiB0YWJsZXMgb24gYSBzY2hlbWFcbmNvbnN0IGpvaW5UYWJsZXNGb3JTY2hlbWEgPSBzY2hlbWEgPT4ge1xuICBjb25zdCBsaXN0ID0gW107XG4gIGlmIChzY2hlbWEpIHtcbiAgICBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5mb3JFYWNoKGZpZWxkID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIGxpc3QucHVzaChgX0pvaW46JHtmaWVsZH06JHtzY2hlbWEuY2xhc3NOYW1lfWApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBsaXN0O1xufTtcblxuaW50ZXJmYWNlIFdoZXJlQ2xhdXNlIHtcbiAgcGF0dGVybjogc3RyaW5nO1xuICB2YWx1ZXM6IEFycmF5PGFueT47XG4gIHNvcnRzOiBBcnJheTxhbnk+O1xufVxuXG5jb25zdCBidWlsZFdoZXJlQ2xhdXNlID0gKHsgc2NoZW1hLCBxdWVyeSwgaW5kZXggfSk6IFdoZXJlQ2xhdXNlID0+IHtcbiAgY29uc3QgcGF0dGVybnMgPSBbXTtcbiAgbGV0IHZhbHVlcyA9IFtdO1xuICBjb25zdCBzb3J0cyA9IFtdO1xuXG4gIHNjaGVtYSA9IHRvUG9zdGdyZXNTY2hlbWEoc2NoZW1hKTtcbiAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gcXVlcnkpIHtcbiAgICBjb25zdCBpc0FycmF5RmllbGQgPVxuICAgICAgc2NoZW1hLmZpZWxkcyAmJlxuICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0FycmF5JztcbiAgICBjb25zdCBpbml0aWFsUGF0dGVybnNMZW5ndGggPSBwYXR0ZXJucy5sZW5ndGg7XG4gICAgY29uc3QgZmllbGRWYWx1ZSA9IHF1ZXJ5W2ZpZWxkTmFtZV07XG5cbiAgICAvLyBub3RoaW5naW4gdGhlIHNjaGVtYSwgaXQncyBnb25uYSBibG93IHVwXG4gICAgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0pIHtcbiAgICAgIC8vIGFzIGl0IHdvbid0IGV4aXN0XG4gICAgICBpZiAoZmllbGRWYWx1ZSAmJiBmaWVsZFZhbHVlLiRleGlzdHMgPT09IGZhbHNlKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDApIHtcbiAgICAgIGxldCBuYW1lID0gdHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCR7bmFtZX0gSVMgTlVMTGApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGZpZWxkVmFsdWUuJGluKSB7XG4gICAgICAgICAgY29uc3QgaW5QYXR0ZXJucyA9IFtdO1xuICAgICAgICAgIG5hbWUgPSB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyhmaWVsZE5hbWUpLmpvaW4oJy0+Jyk7XG4gICAgICAgICAgZmllbGRWYWx1ZS4kaW4uZm9yRWFjaChsaXN0RWxlbSA9PiB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGxpc3RFbGVtID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICBpblBhdHRlcm5zLnB1c2goYFwiJHtsaXN0RWxlbX1cImApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgaW5QYXR0ZXJucy5wdXNoKGAke2xpc3RFbGVtfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCgke25hbWV9KTo6anNvbmIgQD4gJ1ske2luUGF0dGVybnMuam9pbigpfV0nOjpqc29uYmApO1xuICAgICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuJHJlZ2V4KSB7XG4gICAgICAgICAgLy8gSGFuZGxlIGxhdGVyXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcGF0dGVybnMucHVzaChgJHtuYW1lfSA9ICcke2ZpZWxkVmFsdWV9J2ApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlID09PSBudWxsIHx8IGZpZWxkVmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTGApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgIGluZGV4ICs9IDE7XG4gICAgICBjb250aW51ZTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnYm9vbGVhbicpIHtcbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgLy8gQ2FuJ3QgY2FzdCBib29sZWFuIHRvIGRvdWJsZSBwcmVjaXNpb25cbiAgICAgIGlmIChcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnTnVtYmVyJ1xuICAgICAgKSB7XG4gICAgICAgIC8vIFNob3VsZCBhbHdheXMgcmV0dXJuIHplcm8gcmVzdWx0c1xuICAgICAgICBjb25zdCBNQVhfSU5UX1BMVVNfT05FID0gOTIyMzM3MjAzNjg1NDc3NTgwODtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBNQVhfSU5UX1BMVVNfT05FKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICB9XG4gICAgICBpbmRleCArPSAyO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdudW1iZXInKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH0gZWxzZSBpZiAoWyckb3InLCAnJG5vcicsICckYW5kJ10uaW5jbHVkZXMoZmllbGROYW1lKSkge1xuICAgICAgY29uc3QgY2xhdXNlcyA9IFtdO1xuICAgICAgY29uc3QgY2xhdXNlVmFsdWVzID0gW107XG4gICAgICBmaWVsZFZhbHVlLmZvckVhY2goc3ViUXVlcnkgPT4ge1xuICAgICAgICBjb25zdCBjbGF1c2UgPSBidWlsZFdoZXJlQ2xhdXNlKHsgc2NoZW1hLCBxdWVyeTogc3ViUXVlcnksIGluZGV4IH0pO1xuICAgICAgICBpZiAoY2xhdXNlLnBhdHRlcm4ubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNsYXVzZXMucHVzaChjbGF1c2UucGF0dGVybik7XG4gICAgICAgICAgY2xhdXNlVmFsdWVzLnB1c2goLi4uY2xhdXNlLnZhbHVlcyk7XG4gICAgICAgICAgaW5kZXggKz0gY2xhdXNlLnZhbHVlcy5sZW5ndGg7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBvck9yQW5kID0gZmllbGROYW1lID09PSAnJGFuZCcgPyAnIEFORCAnIDogJyBPUiAnO1xuICAgICAgY29uc3Qgbm90ID0gZmllbGROYW1lID09PSAnJG5vcicgPyAnIE5PVCAnIDogJyc7XG5cbiAgICAgIHBhdHRlcm5zLnB1c2goYCR7bm90fSgke2NsYXVzZXMuam9pbihvck9yQW5kKX0pYCk7XG4gICAgICB2YWx1ZXMucHVzaCguLi5jbGF1c2VWYWx1ZXMpO1xuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlLiRuZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoaXNBcnJheUZpZWxkKSB7XG4gICAgICAgIGZpZWxkVmFsdWUuJG5lID0gSlNPTi5zdHJpbmdpZnkoW2ZpZWxkVmFsdWUuJG5lXSk7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYE5PVCBhcnJheV9jb250YWlucygkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfSlgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChmaWVsZFZhbHVlLiRuZSA9PT0gbnVsbCkge1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5PVCBOVUxMYCk7XG4gICAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgICBpbmRleCArPSAxO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIGlmIG5vdCBudWxsLCB3ZSBuZWVkIHRvIG1hbnVhbGx5IGV4Y2x1ZGUgbnVsbFxuICAgICAgICAgIHBhdHRlcm5zLnB1c2goXG4gICAgICAgICAgICBgKCQke2luZGV4fTpuYW1lIDw+ICQke2luZGV4ICsgMX0gT1IgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTClgXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUT0RPOiBzdXBwb3J0IGFycmF5c1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLiRuZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cbiAgICBpZiAoZmllbGRWYWx1ZS4kZXEgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGVxID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5VTExgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUuJGVxKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgaXNJbk9yTmluID1cbiAgICAgIEFycmF5LmlzQXJyYXkoZmllbGRWYWx1ZS4kaW4pIHx8IEFycmF5LmlzQXJyYXkoZmllbGRWYWx1ZS4kbmluKTtcbiAgICBpZiAoXG4gICAgICBBcnJheS5pc0FycmF5KGZpZWxkVmFsdWUuJGluKSAmJlxuICAgICAgaXNBcnJheUZpZWxkICYmXG4gICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uY29udGVudHMgJiZcbiAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5jb250ZW50cy50eXBlID09PSAnU3RyaW5nJ1xuICAgICkge1xuICAgICAgY29uc3QgaW5QYXR0ZXJucyA9IFtdO1xuICAgICAgbGV0IGFsbG93TnVsbCA9IGZhbHNlO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgIGZpZWxkVmFsdWUuJGluLmZvckVhY2goKGxpc3RFbGVtLCBsaXN0SW5kZXgpID0+IHtcbiAgICAgICAgaWYgKGxpc3RFbGVtID09PSBudWxsKSB7XG4gICAgICAgICAgYWxsb3dOdWxsID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YWx1ZXMucHVzaChsaXN0RWxlbSk7XG4gICAgICAgICAgaW5QYXR0ZXJucy5wdXNoKGAkJHtpbmRleCArIDEgKyBsaXN0SW5kZXggLSAoYWxsb3dOdWxsID8gMSA6IDApfWApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChhbGxvd051bGwpIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChcbiAgICAgICAgICBgKCQke2luZGV4fTpuYW1lIElTIE5VTEwgT1IgJCR7aW5kZXh9Om5hbWUgJiYgQVJSQVlbJHtpblBhdHRlcm5zLmpvaW4oKX1dKWBcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lICYmIEFSUkFZWyR7aW5QYXR0ZXJucy5qb2luKCl9XWApO1xuICAgICAgfVxuICAgICAgaW5kZXggPSBpbmRleCArIDEgKyBpblBhdHRlcm5zLmxlbmd0aDtcbiAgICB9IGVsc2UgaWYgKGlzSW5Pck5pbikge1xuICAgICAgdmFyIGNyZWF0ZUNvbnN0cmFpbnQgPSAoYmFzZUFycmF5LCBub3RJbikgPT4ge1xuICAgICAgICBjb25zdCBub3QgPSBub3RJbiA/ICcgTk9UICcgOiAnJztcbiAgICAgICAgaWYgKGJhc2VBcnJheS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgaWYgKGlzQXJyYXlGaWVsZCkge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChcbiAgICAgICAgICAgICAgYCR7bm90fSBhcnJheV9jb250YWlucygkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfSlgXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShiYXNlQXJyYXkpKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIEhhbmRsZSBOZXN0ZWQgRG90IE5vdGF0aW9uIEFib3ZlXG4gICAgICAgICAgICBpZiAoZmllbGROYW1lLmluZGV4T2YoJy4nKSA+PSAwKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGluUGF0dGVybnMgPSBbXTtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICBiYXNlQXJyYXkuZm9yRWFjaCgobGlzdEVsZW0sIGxpc3RJbmRleCkgPT4ge1xuICAgICAgICAgICAgICBpZiAobGlzdEVsZW0gIT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZXMucHVzaChsaXN0RWxlbSk7XG4gICAgICAgICAgICAgICAgaW5QYXR0ZXJucy5wdXNoKGAkJHtpbmRleCArIDEgKyBsaXN0SW5kZXh9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgJHtub3R9IElOICgke2luUGF0dGVybnMuam9pbigpfSlgKTtcbiAgICAgICAgICAgIGluZGV4ID0gaW5kZXggKyAxICsgaW5QYXR0ZXJucy5sZW5ndGg7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKCFub3RJbikge1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTGApO1xuICAgICAgICAgIGluZGV4ID0gaW5kZXggKyAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIEhhbmRsZSBlbXB0eSBhcnJheVxuICAgICAgICAgIGlmIChub3RJbikge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaCgnMSA9IDEnKTsgLy8gUmV0dXJuIGFsbCB2YWx1ZXNcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaCgnMSA9IDInKTsgLy8gUmV0dXJuIG5vIHZhbHVlc1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGlmIChmaWVsZFZhbHVlLiRpbikge1xuICAgICAgICBjcmVhdGVDb25zdHJhaW50KF8uZmxhdE1hcChmaWVsZFZhbHVlLiRpbiwgZWx0ID0+IGVsdCksIGZhbHNlKTtcbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZFZhbHVlLiRuaW4pIHtcbiAgICAgICAgY3JlYXRlQ29uc3RyYWludChfLmZsYXRNYXAoZmllbGRWYWx1ZS4kbmluLCBlbHQgPT4gZWx0KSwgdHJ1ZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZS4kaW4gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICRpbiB2YWx1ZScpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUuJG5pbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdiYWQgJG5pbiB2YWx1ZScpO1xuICAgIH1cblxuICAgIGlmIChBcnJheS5pc0FycmF5KGZpZWxkVmFsdWUuJGFsbCkgJiYgaXNBcnJheUZpZWxkKSB7XG4gICAgICBpZiAoaXNBbnlWYWx1ZVJlZ2V4U3RhcnRzV2l0aChmaWVsZFZhbHVlLiRhbGwpKSB7XG4gICAgICAgIGlmICghaXNBbGxWYWx1ZXNSZWdleE9yTm9uZShmaWVsZFZhbHVlLiRhbGwpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgJ0FsbCAkYWxsIHZhbHVlcyBtdXN0IGJlIG9mIHJlZ2V4IHR5cGUgb3Igbm9uZTogJyArIGZpZWxkVmFsdWUuJGFsbFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGZpZWxkVmFsdWUuJGFsbC5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gcHJvY2Vzc1JlZ2V4UGF0dGVybihmaWVsZFZhbHVlLiRhbGxbaV0uJHJlZ2V4KTtcbiAgICAgICAgICBmaWVsZFZhbHVlLiRhbGxbaV0gPSB2YWx1ZS5zdWJzdHJpbmcoMSkgKyAnJSc7XG4gICAgICAgIH1cbiAgICAgICAgcGF0dGVybnMucHVzaChcbiAgICAgICAgICBgYXJyYXlfY29udGFpbnNfYWxsX3JlZ2V4KCQke2luZGV4fTpuYW1lLCAkJHtpbmRleCArIDF9Ojpqc29uYilgXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKFxuICAgICAgICAgIGBhcnJheV9jb250YWluc19hbGwoJCR7aW5kZXh9Om5hbWUsICQke2luZGV4ICsgMX06Ompzb25iKWBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZS4kYWxsKSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgZmllbGRWYWx1ZS4kZXhpc3RzICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGV4aXN0cykge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOT1QgTlVMTGApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTGApO1xuICAgICAgfVxuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgIGluZGV4ICs9IDE7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJGNvbnRhaW5lZEJ5KSB7XG4gICAgICBjb25zdCBhcnIgPSBmaWVsZFZhbHVlLiRjb250YWluZWRCeTtcbiAgICAgIGlmICghKGFyciBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJGNvbnRhaW5lZEJ5OiBzaG91bGQgYmUgYW4gYXJyYXlgXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIDxAICQke2luZGV4ICsgMX06Ompzb25iYCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGFycikpO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kdGV4dCkge1xuICAgICAgY29uc3Qgc2VhcmNoID0gZmllbGRWYWx1ZS4kdGV4dC4kc2VhcmNoO1xuICAgICAgbGV0IGxhbmd1YWdlID0gJ2VuZ2xpc2gnO1xuICAgICAgaWYgKHR5cGVvZiBzZWFyY2ggIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJHNlYXJjaCwgc2hvdWxkIGJlIG9iamVjdGBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghc2VhcmNoLiR0ZXJtIHx8IHR5cGVvZiBzZWFyY2guJHRlcm0gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJHRlcm0sIHNob3VsZCBiZSBzdHJpbmdgXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoc2VhcmNoLiRsYW5ndWFnZSAmJiB0eXBlb2Ygc2VhcmNoLiRsYW5ndWFnZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkbGFuZ3VhZ2UsIHNob3VsZCBiZSBzdHJpbmdgXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKHNlYXJjaC4kbGFuZ3VhZ2UpIHtcbiAgICAgICAgbGFuZ3VhZ2UgPSBzZWFyY2guJGxhbmd1YWdlO1xuICAgICAgfVxuICAgICAgaWYgKHNlYXJjaC4kY2FzZVNlbnNpdGl2ZSAmJiB0eXBlb2Ygc2VhcmNoLiRjYXNlU2Vuc2l0aXZlICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkY2FzZVNlbnNpdGl2ZSwgc2hvdWxkIGJlIGJvb2xlYW5gXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKHNlYXJjaC4kY2FzZVNlbnNpdGl2ZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJHRleHQ6ICRjYXNlU2Vuc2l0aXZlIG5vdCBzdXBwb3J0ZWQsIHBsZWFzZSB1c2UgJHJlZ2V4IG9yIGNyZWF0ZSBhIHNlcGFyYXRlIGxvd2VyIGNhc2UgY29sdW1uLmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChcbiAgICAgICAgc2VhcmNoLiRkaWFjcml0aWNTZW5zaXRpdmUgJiZcbiAgICAgICAgdHlwZW9mIHNlYXJjaC4kZGlhY3JpdGljU2Vuc2l0aXZlICE9PSAnYm9vbGVhbidcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJHRleHQ6ICRkaWFjcml0aWNTZW5zaXRpdmUsIHNob3VsZCBiZSBib29sZWFuYFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChzZWFyY2guJGRpYWNyaXRpY1NlbnNpdGl2ZSA9PT0gZmFsc2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkZGlhY3JpdGljU2Vuc2l0aXZlIC0gZmFsc2Ugbm90IHN1cHBvcnRlZCwgaW5zdGFsbCBQb3N0Z3JlcyBVbmFjY2VudCBFeHRlbnNpb25gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBwYXR0ZXJucy5wdXNoKFxuICAgICAgICBgdG9fdHN2ZWN0b3IoJCR7aW5kZXh9LCAkJHtpbmRleCArIDF9Om5hbWUpIEBAIHRvX3RzcXVlcnkoJCR7aW5kZXggK1xuICAgICAgICAgIDJ9LCAkJHtpbmRleCArIDN9KWBcbiAgICAgICk7XG4gICAgICB2YWx1ZXMucHVzaChsYW5ndWFnZSwgZmllbGROYW1lLCBsYW5ndWFnZSwgc2VhcmNoLiR0ZXJtKTtcbiAgICAgIGluZGV4ICs9IDQ7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJG5lYXJTcGhlcmUpIHtcbiAgICAgIGNvbnN0IHBvaW50ID0gZmllbGRWYWx1ZS4kbmVhclNwaGVyZTtcbiAgICAgIGNvbnN0IGRpc3RhbmNlID0gZmllbGRWYWx1ZS4kbWF4RGlzdGFuY2U7XG4gICAgICBjb25zdCBkaXN0YW5jZUluS00gPSBkaXN0YW5jZSAqIDYzNzEgKiAxMDAwO1xuICAgICAgcGF0dGVybnMucHVzaChcbiAgICAgICAgYFNUX2Rpc3RhbmNlX3NwaGVyZSgkJHtpbmRleH06bmFtZTo6Z2VvbWV0cnksIFBPSU5UKCQke2luZGV4ICtcbiAgICAgICAgICAxfSwgJCR7aW5kZXggKyAyfSk6Omdlb21ldHJ5KSA8PSAkJHtpbmRleCArIDN9YFxuICAgICAgKTtcbiAgICAgIHNvcnRzLnB1c2goXG4gICAgICAgIGBTVF9kaXN0YW5jZV9zcGhlcmUoJCR7aW5kZXh9Om5hbWU6Omdlb21ldHJ5LCBQT0lOVCgkJHtpbmRleCArXG4gICAgICAgICAgMX0sICQke2luZGV4ICsgMn0pOjpnZW9tZXRyeSkgQVNDYFxuICAgICAgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgcG9pbnQubG9uZ2l0dWRlLCBwb2ludC5sYXRpdHVkZSwgZGlzdGFuY2VJbktNKTtcbiAgICAgIGluZGV4ICs9IDQ7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJHdpdGhpbiAmJiBmaWVsZFZhbHVlLiR3aXRoaW4uJGJveCkge1xuICAgICAgY29uc3QgYm94ID0gZmllbGRWYWx1ZS4kd2l0aGluLiRib3g7XG4gICAgICBjb25zdCBsZWZ0ID0gYm94WzBdLmxvbmdpdHVkZTtcbiAgICAgIGNvbnN0IGJvdHRvbSA9IGJveFswXS5sYXRpdHVkZTtcbiAgICAgIGNvbnN0IHJpZ2h0ID0gYm94WzFdLmxvbmdpdHVkZTtcbiAgICAgIGNvbnN0IHRvcCA9IGJveFsxXS5sYXRpdHVkZTtcblxuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWU6OnBvaW50IDxAICQke2luZGV4ICsgMX06OmJveGApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBgKCgke2xlZnR9LCAke2JvdHRvbX0pLCAoJHtyaWdodH0sICR7dG9wfSkpYCk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlLiRnZW9XaXRoaW4gJiYgZmllbGRWYWx1ZS4kZ2VvV2l0aGluLiRjZW50ZXJTcGhlcmUpIHtcbiAgICAgIGNvbnN0IGNlbnRlclNwaGVyZSA9IGZpZWxkVmFsdWUuJGdlb1dpdGhpbi4kY2VudGVyU3BoZXJlO1xuICAgICAgaWYgKCEoY2VudGVyU3BoZXJlIGluc3RhbmNlb2YgQXJyYXkpIHx8IGNlbnRlclNwaGVyZS5sZW5ndGggPCAyKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkY2VudGVyU3BoZXJlIHNob3VsZCBiZSBhbiBhcnJheSBvZiBQYXJzZS5HZW9Qb2ludCBhbmQgZGlzdGFuY2UnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBHZXQgcG9pbnQsIGNvbnZlcnQgdG8gZ2VvIHBvaW50IGlmIG5lY2Vzc2FyeSBhbmQgdmFsaWRhdGVcbiAgICAgIGxldCBwb2ludCA9IGNlbnRlclNwaGVyZVswXTtcbiAgICAgIGlmIChwb2ludCBpbnN0YW5jZW9mIEFycmF5ICYmIHBvaW50Lmxlbmd0aCA9PT0gMikge1xuICAgICAgICBwb2ludCA9IG5ldyBQYXJzZS5HZW9Qb2ludChwb2ludFsxXSwgcG9pbnRbMF0pO1xuICAgICAgfSBlbHNlIGlmICghR2VvUG9pbnRDb2Rlci5pc1ZhbGlkSlNPTihwb2ludCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRjZW50ZXJTcGhlcmUgZ2VvIHBvaW50IGludmFsaWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBQYXJzZS5HZW9Qb2ludC5fdmFsaWRhdGUocG9pbnQubGF0aXR1ZGUsIHBvaW50LmxvbmdpdHVkZSk7XG4gICAgICAvLyBHZXQgZGlzdGFuY2UgYW5kIHZhbGlkYXRlXG4gICAgICBjb25zdCBkaXN0YW5jZSA9IGNlbnRlclNwaGVyZVsxXTtcbiAgICAgIGlmIChpc05hTihkaXN0YW5jZSkgfHwgZGlzdGFuY2UgPCAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkY2VudGVyU3BoZXJlIGRpc3RhbmNlIGludmFsaWQnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBkaXN0YW5jZUluS00gPSBkaXN0YW5jZSAqIDYzNzEgKiAxMDAwO1xuICAgICAgcGF0dGVybnMucHVzaChcbiAgICAgICAgYFNUX2Rpc3RhbmNlX3NwaGVyZSgkJHtpbmRleH06bmFtZTo6Z2VvbWV0cnksIFBPSU5UKCQke2luZGV4ICtcbiAgICAgICAgICAxfSwgJCR7aW5kZXggKyAyfSk6Omdlb21ldHJ5KSA8PSAkJHtpbmRleCArIDN9YFxuICAgICAgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgcG9pbnQubG9uZ2l0dWRlLCBwb2ludC5sYXRpdHVkZSwgZGlzdGFuY2VJbktNKTtcbiAgICAgIGluZGV4ICs9IDQ7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJGdlb1dpdGhpbiAmJiBmaWVsZFZhbHVlLiRnZW9XaXRoaW4uJHBvbHlnb24pIHtcbiAgICAgIGNvbnN0IHBvbHlnb24gPSBmaWVsZFZhbHVlLiRnZW9XaXRoaW4uJHBvbHlnb247XG4gICAgICBsZXQgcG9pbnRzO1xuICAgICAgaWYgKHR5cGVvZiBwb2x5Z29uID09PSAnb2JqZWN0JyAmJiBwb2x5Z29uLl9fdHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGlmICghcG9seWdvbi5jb29yZGluYXRlcyB8fCBwb2x5Z29uLmNvb3JkaW5hdGVzLmxlbmd0aCA8IDMpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7IFBvbHlnb24uY29vcmRpbmF0ZXMgc2hvdWxkIGNvbnRhaW4gYXQgbGVhc3QgMyBsb24vbGF0IHBhaXJzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcG9pbnRzID0gcG9seWdvbi5jb29yZGluYXRlcztcbiAgICAgIH0gZWxzZSBpZiAocG9seWdvbiBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICAgIGlmIChwb2x5Z29uLmxlbmd0aCA8IDMpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRwb2x5Z29uIHNob3VsZCBjb250YWluIGF0IGxlYXN0IDMgR2VvUG9pbnRzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcG9pbnRzID0gcG9seWdvbjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgXCJiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgJHBvbHlnb24gc2hvdWxkIGJlIFBvbHlnb24gb2JqZWN0IG9yIEFycmF5IG9mIFBhcnNlLkdlb1BvaW50J3NcIlxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcG9pbnRzID0gcG9pbnRzXG4gICAgICAgIC5tYXAocG9pbnQgPT4ge1xuICAgICAgICAgIGlmIChwb2ludCBpbnN0YW5jZW9mIEFycmF5ICYmIHBvaW50Lmxlbmd0aCA9PT0gMikge1xuICAgICAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50WzFdLCBwb2ludFswXSk7XG4gICAgICAgICAgICByZXR1cm4gYCgke3BvaW50WzBdfSwgJHtwb2ludFsxXX0pYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHR5cGVvZiBwb2ludCAhPT0gJ29iamVjdCcgfHwgcG9pbnQuX190eXBlICE9PSAnR2VvUG9pbnQnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlJ1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50LmxhdGl0dWRlLCBwb2ludC5sb25naXR1ZGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gYCgke3BvaW50LmxvbmdpdHVkZX0sICR7cG9pbnQubGF0aXR1ZGV9KWA7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCcsICcpO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZTo6cG9pbnQgPEAgJCR7aW5kZXggKyAxfTo6cG9seWdvbmApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBgKCR7cG9pbnRzfSlgKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuICAgIGlmIChmaWVsZFZhbHVlLiRnZW9JbnRlcnNlY3RzICYmIGZpZWxkVmFsdWUuJGdlb0ludGVyc2VjdHMuJHBvaW50KSB7XG4gICAgICBjb25zdCBwb2ludCA9IGZpZWxkVmFsdWUuJGdlb0ludGVyc2VjdHMuJHBvaW50O1xuICAgICAgaWYgKHR5cGVvZiBwb2ludCAhPT0gJ29iamVjdCcgfHwgcG9pbnQuX190eXBlICE9PSAnR2VvUG9pbnQnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCAkZ2VvSW50ZXJzZWN0IHZhbHVlOyAkcG9pbnQgc2hvdWxkIGJlIEdlb1BvaW50J1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50LmxhdGl0dWRlLCBwb2ludC5sb25naXR1ZGUpO1xuICAgICAgfVxuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWU6OnBvbHlnb24gQD4gJCR7aW5kZXggKyAxfTo6cG9pbnRgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgYCgke3BvaW50LmxvbmdpdHVkZX0sICR7cG9pbnQubGF0aXR1ZGV9KWApO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kcmVnZXgpIHtcbiAgICAgIGxldCByZWdleCA9IGZpZWxkVmFsdWUuJHJlZ2V4O1xuICAgICAgbGV0IG9wZXJhdG9yID0gJ34nO1xuICAgICAgY29uc3Qgb3B0cyA9IGZpZWxkVmFsdWUuJG9wdGlvbnM7XG4gICAgICBpZiAob3B0cykge1xuICAgICAgICBpZiAob3B0cy5pbmRleE9mKCdpJykgPj0gMCkge1xuICAgICAgICAgIG9wZXJhdG9yID0gJ34qJztcbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0cy5pbmRleE9mKCd4JykgPj0gMCkge1xuICAgICAgICAgIHJlZ2V4ID0gcmVtb3ZlV2hpdGVTcGFjZShyZWdleCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgbmFtZSA9IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG5cbiAgICAgIHJlZ2V4ID0gcHJvY2Vzc1JlZ2V4UGF0dGVybihyZWdleCk7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06cmF3ICR7b3BlcmF0b3J9ICckJHtpbmRleCArIDF9OnJhdydgKTtcbiAgICAgIHZhbHVlcy5wdXNoKG5hbWUsIHJlZ2V4KTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgIGlmIChpc0FycmF5RmllbGQpIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgYXJyYXlfY29udGFpbnMoJCR7aW5kZXh9Om5hbWUsICQke2luZGV4ICsgMX0pYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoW2ZpZWxkVmFsdWVdKSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLm9iamVjdElkKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUuaXNvKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnR2VvUG9pbnQnKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKFxuICAgICAgICAnJCcgK1xuICAgICAgICAgIGluZGV4ICtcbiAgICAgICAgICAnOm5hbWUgfj0gUE9JTlQoJCcgK1xuICAgICAgICAgIChpbmRleCArIDEpICtcbiAgICAgICAgICAnLCAkJyArXG4gICAgICAgICAgKGluZGV4ICsgMikgK1xuICAgICAgICAgICcpJ1xuICAgICAgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5sb25naXR1ZGUsIGZpZWxkVmFsdWUubGF0aXR1ZGUpO1xuICAgICAgaW5kZXggKz0gMztcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgY29uc3QgdmFsdWUgPSBjb252ZXJ0UG9seWdvblRvU1FMKGZpZWxkVmFsdWUuY29vcmRpbmF0ZXMpO1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgfj0gJCR7aW5kZXggKyAxfTo6cG9seWdvbmApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCB2YWx1ZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cblxuICAgIE9iamVjdC5rZXlzKFBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvcikuZm9yRWFjaChjbXAgPT4ge1xuICAgICAgaWYgKGZpZWxkVmFsdWVbY21wXSB8fCBmaWVsZFZhbHVlW2NtcF0gPT09IDApIHtcbiAgICAgICAgY29uc3QgcGdDb21wYXJhdG9yID0gUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yW2NtcF07XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lICR7cGdDb21wYXJhdG9yfSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgdG9Qb3N0Z3Jlc1ZhbHVlKGZpZWxkVmFsdWVbY21wXSkpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGluaXRpYWxQYXR0ZXJuc0xlbmd0aCA9PT0gcGF0dGVybnMubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgIGBQb3N0Z3JlcyBkb2Vzbid0IHN1cHBvcnQgdGhpcyBxdWVyeSB0eXBlIHlldCAke0pTT04uc3RyaW5naWZ5KFxuICAgICAgICAgIGZpZWxkVmFsdWVcbiAgICAgICAgKX1gXG4gICAgICApO1xuICAgIH1cbiAgfVxuICB2YWx1ZXMgPSB2YWx1ZXMubWFwKHRyYW5zZm9ybVZhbHVlKTtcbiAgcmV0dXJuIHsgcGF0dGVybjogcGF0dGVybnMuam9pbignIEFORCAnKSwgdmFsdWVzLCBzb3J0cyB9O1xufTtcblxuZXhwb3J0IGNsYXNzIFBvc3RncmVzU3RvcmFnZUFkYXB0ZXIgaW1wbGVtZW50cyBTdG9yYWdlQWRhcHRlciB7XG4gIGNhblNvcnRPbkpvaW5UYWJsZXM6IGJvb2xlYW47XG5cbiAgLy8gUHJpdmF0ZVxuICBfY29sbGVjdGlvblByZWZpeDogc3RyaW5nO1xuICBfY2xpZW50OiBhbnk7XG4gIF9wZ3A6IGFueTtcblxuICBjb25zdHJ1Y3Rvcih7IHVyaSwgY29sbGVjdGlvblByZWZpeCA9ICcnLCBkYXRhYmFzZU9wdGlvbnMgfTogYW55KSB7XG4gICAgdGhpcy5fY29sbGVjdGlvblByZWZpeCA9IGNvbGxlY3Rpb25QcmVmaXg7XG4gICAgY29uc3QgeyBjbGllbnQsIHBncCB9ID0gY3JlYXRlQ2xpZW50KHVyaSwgZGF0YWJhc2VPcHRpb25zKTtcbiAgICB0aGlzLl9jbGllbnQgPSBjbGllbnQ7XG4gICAgdGhpcy5fcGdwID0gcGdwO1xuICAgIHRoaXMuY2FuU29ydE9uSm9pblRhYmxlcyA9IGZhbHNlO1xuICB9XG5cbiAgaGFuZGxlU2h1dGRvd24oKSB7XG4gICAgaWYgKCF0aGlzLl9jbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fY2xpZW50LiRwb29sLmVuZCgpO1xuICB9XG5cbiAgX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHMoY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIHJldHVybiBjb25uXG4gICAgICAubm9uZShcbiAgICAgICAgJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIFwiX1NDSEVNQVwiICggXCJjbGFzc05hbWVcIiB2YXJDaGFyKDEyMCksIFwic2NoZW1hXCIganNvbmIsIFwiaXNQYXJzZUNsYXNzXCIgYm9vbCwgUFJJTUFSWSBLRVkgKFwiY2xhc3NOYW1lXCIpICknXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yIHx8XG4gICAgICAgICAgZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yIHx8XG4gICAgICAgICAgZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNEdXBsaWNhdGVPYmplY3RFcnJvclxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBUYWJsZSBhbHJlYWR5IGV4aXN0cywgbXVzdCBoYXZlIGJlZW4gY3JlYXRlZCBieSBhIGRpZmZlcmVudCByZXF1ZXN0LiBJZ25vcmUgZXJyb3IuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICB9XG5cbiAgY2xhc3NFeGlzdHMobmFtZTogc3RyaW5nKSB7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC5vbmUoXG4gICAgICAnU0VMRUNUIEVYSVNUUyAoU0VMRUNUIDEgRlJPTSBpbmZvcm1hdGlvbl9zY2hlbWEudGFibGVzIFdIRVJFIHRhYmxlX25hbWUgPSAkMSknLFxuICAgICAgW25hbWVdLFxuICAgICAgYSA9PiBhLmV4aXN0c1xuICAgICk7XG4gIH1cblxuICBzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lOiBzdHJpbmcsIENMUHM6IGFueSkge1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQudGFzaygnc2V0LWNsYXNzLWxldmVsLXBlcm1pc3Npb25zJywgZnVuY3Rpb24qKHQpIHtcbiAgICAgIHlpZWxkIHNlbGYuX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHModCk7XG4gICAgICBjb25zdCB2YWx1ZXMgPSBbXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgJ3NjaGVtYScsXG4gICAgICAgICdjbGFzc0xldmVsUGVybWlzc2lvbnMnLFxuICAgICAgICBKU09OLnN0cmluZ2lmeShDTFBzKSxcbiAgICAgIF07XG4gICAgICB5aWVsZCB0Lm5vbmUoXG4gICAgICAgIGBVUERBVEUgXCJfU0NIRU1BXCIgU0VUICQyOm5hbWUgPSBqc29uX29iamVjdF9zZXRfa2V5KCQyOm5hbWUsICQzOjp0ZXh0LCAkNDo6anNvbmIpIFdIRVJFIFwiY2xhc3NOYW1lXCI9JDFgLFxuICAgICAgICB2YWx1ZXNcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICBzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzdWJtaXR0ZWRJbmRleGVzOiBhbnksXG4gICAgZXhpc3RpbmdJbmRleGVzOiBhbnkgPSB7fSxcbiAgICBmaWVsZHM6IGFueSxcbiAgICBjb25uOiA/YW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbm4gPSBjb25uIHx8IHRoaXMuX2NsaWVudDtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBpZiAoc3VibWl0dGVkSW5kZXhlcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgfVxuICAgIGlmIChPYmplY3Qua2V5cyhleGlzdGluZ0luZGV4ZXMpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgZXhpc3RpbmdJbmRleGVzID0geyBfaWRfOiB7IF9pZDogMSB9IH07XG4gICAgfVxuICAgIGNvbnN0IGRlbGV0ZWRJbmRleGVzID0gW107XG4gICAgY29uc3QgaW5zZXJ0ZWRJbmRleGVzID0gW107XG4gICAgT2JqZWN0LmtleXMoc3VibWl0dGVkSW5kZXhlcykuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkID0gc3VibWl0dGVkSW5kZXhlc1tuYW1lXTtcbiAgICAgIGlmIChleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCAhPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgYEluZGV4ICR7bmFtZX0gZXhpc3RzLCBjYW5ub3QgdXBkYXRlLmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghZXhpc3RpbmdJbmRleGVzW25hbWVdICYmIGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgIGBJbmRleCAke25hbWV9IGRvZXMgbm90IGV4aXN0LCBjYW5ub3QgZGVsZXRlLmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZC5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICBkZWxldGVkSW5kZXhlcy5wdXNoKG5hbWUpO1xuICAgICAgICBkZWxldGUgZXhpc3RpbmdJbmRleGVzW25hbWVdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgT2JqZWN0LmtleXMoZmllbGQpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICBpZiAoIWZpZWxkcy5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgICAgIGBGaWVsZCAke2tleX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBhZGQgaW5kZXguYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBleGlzdGluZ0luZGV4ZXNbbmFtZV0gPSBmaWVsZDtcbiAgICAgICAgaW5zZXJ0ZWRJbmRleGVzLnB1c2goe1xuICAgICAgICAgIGtleTogZmllbGQsXG4gICAgICAgICAgbmFtZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIGNvbm4udHgoJ3NldC1pbmRleGVzLXdpdGgtc2NoZW1hLWZvcm1hdCcsIGZ1bmN0aW9uKih0KSB7XG4gICAgICBpZiAoaW5zZXJ0ZWRJbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQgc2VsZi5jcmVhdGVJbmRleGVzKGNsYXNzTmFtZSwgaW5zZXJ0ZWRJbmRleGVzLCB0KTtcbiAgICAgIH1cbiAgICAgIGlmIChkZWxldGVkSW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHlpZWxkIHNlbGYuZHJvcEluZGV4ZXMoY2xhc3NOYW1lLCBkZWxldGVkSW5kZXhlcywgdCk7XG4gICAgICB9XG4gICAgICB5aWVsZCBzZWxmLl9lbnN1cmVTY2hlbWFDb2xsZWN0aW9uRXhpc3RzKHQpO1xuICAgICAgeWllbGQgdC5ub25lKFxuICAgICAgICAnVVBEQVRFIFwiX1NDSEVNQVwiIFNFVCAkMjpuYW1lID0ganNvbl9vYmplY3Rfc2V0X2tleSgkMjpuYW1lLCAkMzo6dGV4dCwgJDQ6Ompzb25iKSBXSEVSRSBcImNsYXNzTmFtZVwiPSQxJyxcbiAgICAgICAgW2NsYXNzTmFtZSwgJ3NjaGVtYScsICdpbmRleGVzJywgSlNPTi5zdHJpbmdpZnkoZXhpc3RpbmdJbmRleGVzKV1cbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICBjcmVhdGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBjb25uOiA/YW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIHJldHVybiBjb25uXG4gICAgICAudHgoJ2NyZWF0ZS1jbGFzcycsIHQgPT4ge1xuICAgICAgICBjb25zdCBxMSA9IHRoaXMuY3JlYXRlVGFibGUoY2xhc3NOYW1lLCBzY2hlbWEsIHQpO1xuICAgICAgICBjb25zdCBxMiA9IHQubm9uZShcbiAgICAgICAgICAnSU5TRVJUIElOVE8gXCJfU0NIRU1BXCIgKFwiY2xhc3NOYW1lXCIsIFwic2NoZW1hXCIsIFwiaXNQYXJzZUNsYXNzXCIpIFZBTFVFUyAoJDxjbGFzc05hbWU+LCAkPHNjaGVtYT4sIHRydWUpJyxcbiAgICAgICAgICB7IGNsYXNzTmFtZSwgc2NoZW1hIH1cbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgcTMgPSB0aGlzLnNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICBzY2hlbWEuaW5kZXhlcyxcbiAgICAgICAgICB7fSxcbiAgICAgICAgICBzY2hlbWEuZmllbGRzLFxuICAgICAgICAgIHRcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIHQuYmF0Y2goW3ExLCBxMiwgcTNdKTtcbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiB0b1BhcnNlU2NoZW1hKHNjaGVtYSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgIGlmIChlcnIuZGF0YVswXS5yZXN1bHQuY29kZSA9PT0gUG9zdGdyZXNUcmFuc2FjdGlvbkFib3J0ZWRFcnJvcikge1xuICAgICAgICAgIGVyciA9IGVyci5kYXRhWzFdLnJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBpZiAoXG4gICAgICAgICAgZXJyLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvciAmJlxuICAgICAgICAgIGVyci5kZXRhaWwuaW5jbHVkZXMoY2xhc3NOYW1lKVxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICBgQ2xhc3MgJHtjbGFzc05hbWV9IGFscmVhZHkgZXhpc3RzLmBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gSnVzdCBjcmVhdGUgYSB0YWJsZSwgZG8gbm90IGluc2VydCBpbiBzY2hlbWFcbiAgY3JlYXRlVGFibGUoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIGRlYnVnKCdjcmVhdGVUYWJsZScsIGNsYXNzTmFtZSwgc2NoZW1hKTtcbiAgICBjb25zdCB2YWx1ZXNBcnJheSA9IFtdO1xuICAgIGNvbnN0IHBhdHRlcm5zQXJyYXkgPSBbXTtcbiAgICBjb25zdCBmaWVsZHMgPSBPYmplY3QuYXNzaWduKHt9LCBzY2hlbWEuZmllbGRzKTtcbiAgICBpZiAoY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICBmaWVsZHMuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0ID0geyB0eXBlOiAnRGF0ZScgfTtcbiAgICAgIGZpZWxkcy5fZW1haWxfdmVyaWZ5X3Rva2VuID0geyB0eXBlOiAnU3RyaW5nJyB9O1xuICAgICAgZmllbGRzLl9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCA9IHsgdHlwZTogJ0RhdGUnIH07XG4gICAgICBmaWVsZHMuX2ZhaWxlZF9sb2dpbl9jb3VudCA9IHsgdHlwZTogJ051bWJlcicgfTtcbiAgICAgIGZpZWxkcy5fcGVyaXNoYWJsZV90b2tlbiA9IHsgdHlwZTogJ1N0cmluZycgfTtcbiAgICAgIGZpZWxkcy5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0ID0geyB0eXBlOiAnRGF0ZScgfTtcbiAgICAgIGZpZWxkcy5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IHsgdHlwZTogJ0RhdGUnIH07XG4gICAgICBmaWVsZHMuX3Bhc3N3b3JkX2hpc3RvcnkgPSB7IHR5cGU6ICdBcnJheScgfTtcbiAgICB9XG4gICAgbGV0IGluZGV4ID0gMjtcbiAgICBjb25zdCByZWxhdGlvbnMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhmaWVsZHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlVHlwZSA9IGZpZWxkc1tmaWVsZE5hbWVdO1xuICAgICAgLy8gU2tpcCB3aGVuIGl0J3MgYSByZWxhdGlvblxuICAgICAgLy8gV2UnbGwgY3JlYXRlIHRoZSB0YWJsZXMgbGF0ZXJcbiAgICAgIGlmIChwYXJzZVR5cGUudHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICByZWxhdGlvbnMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAoWydfcnBlcm0nLCAnX3dwZXJtJ10uaW5kZXhPZihmaWVsZE5hbWUpID49IDApIHtcbiAgICAgICAgcGFyc2VUeXBlLmNvbnRlbnRzID0geyB0eXBlOiAnU3RyaW5nJyB9O1xuICAgICAgfVxuICAgICAgdmFsdWVzQXJyYXkucHVzaChmaWVsZE5hbWUpO1xuICAgICAgdmFsdWVzQXJyYXkucHVzaChwYXJzZVR5cGVUb1Bvc3RncmVzVHlwZShwYXJzZVR5cGUpKTtcbiAgICAgIHBhdHRlcm5zQXJyYXkucHVzaChgJCR7aW5kZXh9Om5hbWUgJCR7aW5kZXggKyAxfTpyYXdgKTtcbiAgICAgIGlmIChmaWVsZE5hbWUgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgcGF0dGVybnNBcnJheS5wdXNoKGBQUklNQVJZIEtFWSAoJCR7aW5kZXh9Om5hbWUpYCk7XG4gICAgICB9XG4gICAgICBpbmRleCA9IGluZGV4ICsgMjtcbiAgICB9KTtcbiAgICBjb25zdCBxcyA9IGBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyAkMTpuYW1lICgke3BhdHRlcm5zQXJyYXkuam9pbigpfSlgO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWUsIC4uLnZhbHVlc0FycmF5XTtcblxuICAgIGRlYnVnKHFzLCB2YWx1ZXMpO1xuICAgIHJldHVybiBjb25uLnRhc2soJ2NyZWF0ZS10YWJsZScsIGZ1bmN0aW9uKih0KSB7XG4gICAgICB0cnkge1xuICAgICAgICB5aWVsZCBzZWxmLl9lbnN1cmVTY2hlbWFDb2xsZWN0aW9uRXhpc3RzKHQpO1xuICAgICAgICB5aWVsZCB0Lm5vbmUocXMsIHZhbHVlcyk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgLy8gRUxTRTogVGFibGUgYWxyZWFkeSBleGlzdHMsIG11c3QgaGF2ZSBiZWVuIGNyZWF0ZWQgYnkgYSBkaWZmZXJlbnQgcmVxdWVzdC4gSWdub3JlIHRoZSBlcnJvci5cbiAgICAgIH1cbiAgICAgIHlpZWxkIHQudHgoJ2NyZWF0ZS10YWJsZS10eCcsIHR4ID0+IHtcbiAgICAgICAgcmV0dXJuIHR4LmJhdGNoKFxuICAgICAgICAgIHJlbGF0aW9ucy5tYXAoZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0eC5ub25lKFxuICAgICAgICAgICAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgJDxqb2luVGFibGU6bmFtZT4gKFwicmVsYXRlZElkXCIgdmFyQ2hhcigxMjApLCBcIm93bmluZ0lkXCIgdmFyQ2hhcigxMjApLCBQUklNQVJZIEtFWShcInJlbGF0ZWRJZFwiLCBcIm93bmluZ0lkXCIpICknLFxuICAgICAgICAgICAgICB7IGpvaW5UYWJsZTogYF9Kb2luOiR7ZmllbGROYW1lfToke2NsYXNzTmFtZX1gIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgc2NoZW1hVXBncmFkZShjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBjb25uOiBhbnkpIHtcbiAgICBkZWJ1Zygnc2NoZW1hVXBncmFkZScsIHsgY2xhc3NOYW1lLCBzY2hlbWEgfSk7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuXG4gICAgcmV0dXJuIGNvbm4udHgoJ3NjaGVtYS11cGdyYWRlJywgZnVuY3Rpb24qKHQpIHtcbiAgICAgIGNvbnN0IGNvbHVtbnMgPSB5aWVsZCB0Lm1hcChcbiAgICAgICAgJ1NFTEVDVCBjb2x1bW5fbmFtZSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS5jb2x1bW5zIFdIRVJFIHRhYmxlX25hbWUgPSAkPGNsYXNzTmFtZT4nLFxuICAgICAgICB7IGNsYXNzTmFtZSB9LFxuICAgICAgICBhID0+IGEuY29sdW1uX25hbWVcbiAgICAgICk7XG4gICAgICBjb25zdCBuZXdDb2x1bW5zID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcylcbiAgICAgICAgLmZpbHRlcihpdGVtID0+IGNvbHVtbnMuaW5kZXhPZihpdGVtKSA9PT0gLTEpXG4gICAgICAgIC5tYXAoZmllbGROYW1lID0+XG4gICAgICAgICAgc2VsZi5hZGRGaWVsZElmTm90RXhpc3RzKFxuICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLFxuICAgICAgICAgICAgdFxuICAgICAgICAgIClcbiAgICAgICAgKTtcblxuICAgICAgeWllbGQgdC5iYXRjaChuZXdDb2x1bW5zKTtcbiAgICB9KTtcbiAgfVxuXG4gIGFkZEZpZWxkSWZOb3RFeGlzdHMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgZmllbGROYW1lOiBzdHJpbmcsXG4gICAgdHlwZTogYW55LFxuICAgIGNvbm46IGFueVxuICApIHtcbiAgICAvLyBUT0RPOiBNdXN0IGJlIHJldmlzZWQgZm9yIGludmFsaWQgbG9naWMuLi5cbiAgICBkZWJ1ZygnYWRkRmllbGRJZk5vdEV4aXN0cycsIHsgY2xhc3NOYW1lLCBmaWVsZE5hbWUsIHR5cGUgfSk7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBjb25uLnR4KCdhZGQtZmllbGQtaWYtbm90LWV4aXN0cycsIGZ1bmN0aW9uKih0KSB7XG4gICAgICBpZiAodHlwZS50eXBlICE9PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgeWllbGQgdC5ub25lKFxuICAgICAgICAgICAgJ0FMVEVSIFRBQkxFICQ8Y2xhc3NOYW1lOm5hbWU+IEFERCBDT0xVTU4gJDxmaWVsZE5hbWU6bmFtZT4gJDxwb3N0Z3Jlc1R5cGU6cmF3PicsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICBwb3N0Z3Jlc1R5cGU6IHBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlKHR5cGUpLFxuICAgICAgICAgICAgfVxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzUmVsYXRpb25Eb2VzTm90RXhpc3RFcnJvcikge1xuICAgICAgICAgICAgcmV0dXJuIHlpZWxkIHNlbGYuY3JlYXRlQ2xhc3MoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBmaWVsZHM6IHsgW2ZpZWxkTmFtZV06IHR5cGUgfSB9LFxuICAgICAgICAgICAgICB0XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNEdXBsaWNhdGVDb2x1bW5FcnJvcikge1xuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIENvbHVtbiBhbHJlYWR5IGV4aXN0cywgY3JlYXRlZCBieSBvdGhlciByZXF1ZXN0LiBDYXJyeSBvbiB0byBzZWUgaWYgaXQncyB0aGUgcmlnaHQgdHlwZS5cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgeWllbGQgdC5ub25lKFxuICAgICAgICAgICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyAkPGpvaW5UYWJsZTpuYW1lPiAoXCJyZWxhdGVkSWRcIiB2YXJDaGFyKDEyMCksIFwib3duaW5nSWRcIiB2YXJDaGFyKDEyMCksIFBSSU1BUlkgS0VZKFwicmVsYXRlZElkXCIsIFwib3duaW5nSWRcIikgKScsXG4gICAgICAgICAgeyBqb2luVGFibGU6IGBfSm9pbjoke2ZpZWxkTmFtZX06JHtjbGFzc05hbWV9YCB9XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHlpZWxkIHQuYW55KFxuICAgICAgICAnU0VMRUNUIFwic2NoZW1hXCIgRlJPTSBcIl9TQ0hFTUFcIiBXSEVSRSBcImNsYXNzTmFtZVwiID0gJDxjbGFzc05hbWU+IGFuZCAoXCJzY2hlbWFcIjo6anNvbi0+XFwnZmllbGRzXFwnLT4kPGZpZWxkTmFtZT4pIGlzIG5vdCBudWxsJyxcbiAgICAgICAgeyBjbGFzc05hbWUsIGZpZWxkTmFtZSB9XG4gICAgICApO1xuXG4gICAgICBpZiAocmVzdWx0WzBdKSB7XG4gICAgICAgIHRocm93ICdBdHRlbXB0ZWQgdG8gYWRkIGEgZmllbGQgdGhhdCBhbHJlYWR5IGV4aXN0cyc7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBwYXRoID0gYHtmaWVsZHMsJHtmaWVsZE5hbWV9fWA7XG4gICAgICAgIHlpZWxkIHQubm9uZShcbiAgICAgICAgICAnVVBEQVRFIFwiX1NDSEVNQVwiIFNFVCBcInNjaGVtYVwiPWpzb25iX3NldChcInNjaGVtYVwiLCAkPHBhdGg+LCAkPHR5cGU+KSAgV0hFUkUgXCJjbGFzc05hbWVcIj0kPGNsYXNzTmFtZT4nLFxuICAgICAgICAgIHsgcGF0aCwgdHlwZSwgY2xhc3NOYW1lIH1cbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIERyb3BzIGEgY29sbGVjdGlvbi4gUmVzb2x2ZXMgd2l0aCB0cnVlIGlmIGl0IHdhcyBhIFBhcnNlIFNjaGVtYSAoZWcuIF9Vc2VyLCBDdXN0b20sIGV0Yy4pXG4gIC8vIGFuZCByZXNvbHZlcyB3aXRoIGZhbHNlIGlmIGl0IHdhc24ndCAoZWcuIGEgam9pbiB0YWJsZSkuIFJlamVjdHMgaWYgZGVsZXRpb24gd2FzIGltcG9zc2libGUuXG4gIGRlbGV0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3Qgb3BlcmF0aW9ucyA9IFtcbiAgICAgIHsgcXVlcnk6IGBEUk9QIFRBQkxFIElGIEVYSVNUUyAkMTpuYW1lYCwgdmFsdWVzOiBbY2xhc3NOYW1lXSB9LFxuICAgICAge1xuICAgICAgICBxdWVyeTogYERFTEVURSBGUk9NIFwiX1NDSEVNQVwiIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkMWAsXG4gICAgICAgIHZhbHVlczogW2NsYXNzTmFtZV0sXG4gICAgICB9LFxuICAgIF07XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLnR4KHQgPT4gdC5ub25lKHRoaXMuX3BncC5oZWxwZXJzLmNvbmNhdChvcGVyYXRpb25zKSkpXG4gICAgICAudGhlbigoKSA9PiBjbGFzc05hbWUuaW5kZXhPZignX0pvaW46JykgIT0gMCk7IC8vIHJlc29sdmVzIHdpdGggZmFsc2Ugd2hlbiBfSm9pbiB0YWJsZVxuICB9XG5cbiAgLy8gRGVsZXRlIGFsbCBkYXRhIGtub3duIHRvIHRoaXMgYWRhcHRlci4gVXNlZCBmb3IgdGVzdGluZy5cbiAgZGVsZXRlQWxsQ2xhc3NlcygpIHtcbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcbiAgICBjb25zdCBoZWxwZXJzID0gdGhpcy5fcGdwLmhlbHBlcnM7XG4gICAgZGVidWcoJ2RlbGV0ZUFsbENsYXNzZXMnKTtcblxuICAgIHJldHVybiB0aGlzLl9jbGllbnRcbiAgICAgIC50YXNrKCdkZWxldGUtYWxsLWNsYXNzZXMnLCBmdW5jdGlvbioodCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHJlc3VsdHMgPSB5aWVsZCB0LmFueSgnU0VMRUNUICogRlJPTSBcIl9TQ0hFTUFcIicpO1xuICAgICAgICAgIGNvbnN0IGpvaW5zID0gcmVzdWx0cy5yZWR1Y2UoKGxpc3Q6IEFycmF5PHN0cmluZz4sIHNjaGVtYTogYW55KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gbGlzdC5jb25jYXQoam9pblRhYmxlc0ZvclNjaGVtYShzY2hlbWEuc2NoZW1hKSk7XG4gICAgICAgICAgfSwgW10pO1xuICAgICAgICAgIGNvbnN0IGNsYXNzZXMgPSBbXG4gICAgICAgICAgICAnX1NDSEVNQScsXG4gICAgICAgICAgICAnX1B1c2hTdGF0dXMnLFxuICAgICAgICAgICAgJ19Kb2JTdGF0dXMnLFxuICAgICAgICAgICAgJ19Kb2JTY2hlZHVsZScsXG4gICAgICAgICAgICAnX0hvb2tzJyxcbiAgICAgICAgICAgICdfR2xvYmFsQ29uZmlnJyxcbiAgICAgICAgICAgICdfQXVkaWVuY2UnLFxuICAgICAgICAgICAgLi4ucmVzdWx0cy5tYXAocmVzdWx0ID0+IHJlc3VsdC5jbGFzc05hbWUpLFxuICAgICAgICAgICAgLi4uam9pbnMsXG4gICAgICAgICAgXTtcbiAgICAgICAgICBjb25zdCBxdWVyaWVzID0gY2xhc3Nlcy5tYXAoY2xhc3NOYW1lID0+ICh7XG4gICAgICAgICAgICBxdWVyeTogJ0RST1AgVEFCTEUgSUYgRVhJU1RTICQ8Y2xhc3NOYW1lOm5hbWU+JyxcbiAgICAgICAgICAgIHZhbHVlczogeyBjbGFzc05hbWUgfSxcbiAgICAgICAgICB9KSk7XG4gICAgICAgICAgeWllbGQgdC50eCh0eCA9PiB0eC5ub25lKGhlbHBlcnMuY29uY2F0KHF1ZXJpZXMpKSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKGVycm9yLmNvZGUgIT09IFBvc3RncmVzUmVsYXRpb25Eb2VzTm90RXhpc3RFcnJvcikge1xuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIE5vIF9TQ0hFTUEgY29sbGVjdGlvbi4gRG9uJ3QgZGVsZXRlIGFueXRoaW5nLlxuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBkZWJ1ZyhgZGVsZXRlQWxsQ2xhc3NlcyBkb25lIGluICR7bmV3IERhdGUoKS5nZXRUaW1lKCkgLSBub3d9YCk7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIFJlbW92ZSB0aGUgY29sdW1uIGFuZCBhbGwgdGhlIGRhdGEuIEZvciBSZWxhdGlvbnMsIHRoZSBfSm9pbiBjb2xsZWN0aW9uIGlzIGhhbmRsZWRcbiAgLy8gc3BlY2lhbGx5LCB0aGlzIGZ1bmN0aW9uIGRvZXMgbm90IGRlbGV0ZSBfSm9pbiBjb2x1bW5zLiBJdCBzaG91bGQsIGhvd2V2ZXIsIGluZGljYXRlXG4gIC8vIHRoYXQgdGhlIHJlbGF0aW9uIGZpZWxkcyBkb2VzIG5vdCBleGlzdCBhbnltb3JlLiBJbiBtb25nbywgdGhpcyBtZWFucyByZW1vdmluZyBpdCBmcm9tXG4gIC8vIHRoZSBfU0NIRU1BIGNvbGxlY3Rpb24uICBUaGVyZSBzaG91bGQgYmUgbm8gYWN0dWFsIGRhdGEgaW4gdGhlIGNvbGxlY3Rpb24gdW5kZXIgdGhlIHNhbWUgbmFtZVxuICAvLyBhcyB0aGUgcmVsYXRpb24gY29sdW1uLCBzbyBpdCdzIGZpbmUgdG8gYXR0ZW1wdCB0byBkZWxldGUgaXQuIElmIHRoZSBmaWVsZHMgbGlzdGVkIHRvIGJlXG4gIC8vIGRlbGV0ZWQgZG8gbm90IGV4aXN0LCB0aGlzIGZ1bmN0aW9uIHNob3VsZCByZXR1cm4gc3VjY2Vzc2Z1bGx5IGFueXdheXMuIENoZWNraW5nIGZvclxuICAvLyBhdHRlbXB0cyB0byBkZWxldGUgbm9uLWV4aXN0ZW50IGZpZWxkcyBpcyB0aGUgcmVzcG9uc2liaWxpdHkgb2YgUGFyc2UgU2VydmVyLlxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgbm90IG9ibGlnYXRlZCB0byBkZWxldGUgZmllbGRzIGF0b21pY2FsbHkuIEl0IGlzIGdpdmVuIHRoZSBmaWVsZFxuICAvLyBuYW1lcyBpbiBhIGxpc3Qgc28gdGhhdCBkYXRhYmFzZXMgdGhhdCBhcmUgY2FwYWJsZSBvZiBkZWxldGluZyBmaWVsZHMgYXRvbWljYWxseVxuICAvLyBtYXkgZG8gc28uXG5cbiAgLy8gUmV0dXJucyBhIFByb21pc2UuXG4gIGRlbGV0ZUZpZWxkcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgZmllbGROYW1lczogc3RyaW5nW11cbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgZGVidWcoJ2RlbGV0ZUZpZWxkcycsIGNsYXNzTmFtZSwgZmllbGROYW1lcyk7XG4gICAgZmllbGROYW1lcyA9IGZpZWxkTmFtZXMucmVkdWNlKChsaXN0OiBBcnJheTxzdHJpbmc+LCBmaWVsZE5hbWU6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgZmllbGQgPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICBpZiAoZmllbGQudHlwZSAhPT0gJ1JlbGF0aW9uJykge1xuICAgICAgICBsaXN0LnB1c2goZmllbGROYW1lKTtcbiAgICAgIH1cbiAgICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICByZXR1cm4gbGlzdDtcbiAgICB9LCBbXSk7XG5cbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lLCAuLi5maWVsZE5hbWVzXTtcbiAgICBjb25zdCBjb2x1bW5zID0gZmllbGROYW1lc1xuICAgICAgLm1hcCgobmFtZSwgaWR4KSA9PiB7XG4gICAgICAgIHJldHVybiBgJCR7aWR4ICsgMn06bmFtZWA7XG4gICAgICB9KVxuICAgICAgLmpvaW4oJywgRFJPUCBDT0xVTU4nKTtcblxuICAgIHJldHVybiB0aGlzLl9jbGllbnQudHgoJ2RlbGV0ZS1maWVsZHMnLCBmdW5jdGlvbioodCkge1xuICAgICAgeWllbGQgdC5ub25lKFxuICAgICAgICAnVVBEQVRFIFwiX1NDSEVNQVwiIFNFVCBcInNjaGVtYVwiPSQ8c2NoZW1hPiBXSEVSRSBcImNsYXNzTmFtZVwiPSQ8Y2xhc3NOYW1lPicsXG4gICAgICAgIHsgc2NoZW1hLCBjbGFzc05hbWUgfVxuICAgICAgKTtcbiAgICAgIGlmICh2YWx1ZXMubGVuZ3RoID4gMSkge1xuICAgICAgICB5aWVsZCB0Lm5vbmUoYEFMVEVSIFRBQkxFICQxOm5hbWUgRFJPUCBDT0xVTU4gJHtjb2x1bW5zfWAsIHZhbHVlcyk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciBhbGwgc2NoZW1hcyBrbm93biB0byB0aGlzIGFkYXB0ZXIsIGluIFBhcnNlIGZvcm1hdC4gSW4gY2FzZSB0aGVcbiAgLy8gc2NoZW1hcyBjYW5ub3QgYmUgcmV0cmlldmVkLCByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMuIFJlcXVpcmVtZW50cyBmb3IgdGhlXG4gIC8vIHJlamVjdGlvbiByZWFzb24gYXJlIFRCRC5cbiAgZ2V0QWxsQ2xhc3NlcygpIHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50LnRhc2soJ2dldC1hbGwtY2xhc3NlcycsIGZ1bmN0aW9uKih0KSB7XG4gICAgICB5aWVsZCBzZWxmLl9lbnN1cmVTY2hlbWFDb2xsZWN0aW9uRXhpc3RzKHQpO1xuICAgICAgcmV0dXJuIHlpZWxkIHQubWFwKCdTRUxFQ1QgKiBGUk9NIFwiX1NDSEVNQVwiJywgbnVsbCwgcm93ID0+XG4gICAgICAgIHRvUGFyc2VTY2hlbWEoeyBjbGFzc05hbWU6IHJvdy5jbGFzc05hbWUsIC4uLnJvdy5zY2hlbWEgfSlcbiAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBSZXR1cm4gYSBwcm9taXNlIGZvciB0aGUgc2NoZW1hIHdpdGggdGhlIGdpdmVuIG5hbWUsIGluIFBhcnNlIGZvcm1hdC4gSWZcbiAgLy8gdGhpcyBhZGFwdGVyIGRvZXNuJ3Qga25vdyBhYm91dCB0aGUgc2NoZW1hLCByZXR1cm4gYSBwcm9taXNlIHRoYXQgcmVqZWN0cyB3aXRoXG4gIC8vIHVuZGVmaW5lZCBhcyB0aGUgcmVhc29uLlxuICBnZXRDbGFzcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIGRlYnVnKCdnZXRDbGFzcycsIGNsYXNzTmFtZSk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLmFueSgnU0VMRUNUICogRlJPTSBcIl9TQ0hFTUFcIiBXSEVSRSBcImNsYXNzTmFtZVwiPSQ8Y2xhc3NOYW1lPicsIHtcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgfSlcbiAgICAgIC50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHRbMF0uc2NoZW1hO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHRvUGFyc2VTY2hlbWEpO1xuICB9XG5cbiAgLy8gVE9ETzogcmVtb3ZlIHRoZSBtb25nbyBmb3JtYXQgZGVwZW5kZW5jeSBpbiB0aGUgcmV0dXJuIHZhbHVlXG4gIGNyZWF0ZU9iamVjdChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBvYmplY3Q6IGFueSkge1xuICAgIGRlYnVnKCdjcmVhdGVPYmplY3QnLCBjbGFzc05hbWUsIG9iamVjdCk7XG4gICAgbGV0IGNvbHVtbnNBcnJheSA9IFtdO1xuICAgIGNvbnN0IHZhbHVlc0FycmF5ID0gW107XG4gICAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGdlb1BvaW50cyA9IHt9O1xuXG4gICAgb2JqZWN0ID0gaGFuZGxlRG90RmllbGRzKG9iamVjdCk7XG5cbiAgICB2YWxpZGF0ZUtleXMob2JqZWN0KTtcblxuICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHZhciBhdXRoRGF0YU1hdGNoID0gZmllbGROYW1lLm1hdGNoKC9eX2F1dGhfZGF0YV8oW2EtekEtWjAtOV9dKykkLyk7XG4gICAgICBpZiAoYXV0aERhdGFNYXRjaCkge1xuICAgICAgICB2YXIgcHJvdmlkZXIgPSBhdXRoRGF0YU1hdGNoWzFdO1xuICAgICAgICBvYmplY3RbJ2F1dGhEYXRhJ10gPSBvYmplY3RbJ2F1dGhEYXRhJ10gfHwge307XG4gICAgICAgIG9iamVjdFsnYXV0aERhdGEnXVtwcm92aWRlcl0gPSBvYmplY3RbZmllbGROYW1lXTtcbiAgICAgICAgZGVsZXRlIG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICBmaWVsZE5hbWUgPSAnYXV0aERhdGEnO1xuICAgICAgfVxuXG4gICAgICBjb2x1bW5zQXJyYXkucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBmaWVsZE5hbWUgPT09ICdfZW1haWxfdmVyaWZ5X3Rva2VuJyB8fFxuICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19mYWlsZWRfbG9naW5fY291bnQnIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3BlcmlzaGFibGVfdG9rZW4nIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3Bhc3N3b3JkX2hpc3RvcnknXG4gICAgICAgICkge1xuICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJ19lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCcpIHtcbiAgICAgICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0pIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0uaXNvKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChudWxsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXG4gICAgICAgICAgZmllbGROYW1lID09PSAnX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0JyB8fFxuICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQnIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnXG4gICAgICAgICkge1xuICAgICAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSkge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5pc28pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlKSB7XG4gICAgICAgIGNhc2UgJ0RhdGUnOlxuICAgICAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSkge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5pc28pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnUG9pbnRlcic6XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5vYmplY3RJZCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0FycmF5JzpcbiAgICAgICAgICBpZiAoWydfcnBlcm0nLCAnX3dwZXJtJ10uaW5kZXhPZihmaWVsZE5hbWUpID49IDApIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKEpTT04uc3RyaW5naWZ5KG9iamVjdFtmaWVsZE5hbWVdKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdPYmplY3QnOlxuICAgICAgICBjYXNlICdCeXRlcyc6XG4gICAgICAgIGNhc2UgJ1N0cmluZyc6XG4gICAgICAgIGNhc2UgJ051bWJlcic6XG4gICAgICAgIGNhc2UgJ0Jvb2xlYW4nOlxuICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdGaWxlJzpcbiAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG9iamVjdFtmaWVsZE5hbWVdLm5hbWUpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdQb2x5Z29uJzoge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gY29udmVydFBvbHlnb25Ub1NRTChvYmplY3RbZmllbGROYW1lXS5jb29yZGluYXRlcyk7XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaCh2YWx1ZSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgY2FzZSAnR2VvUG9pbnQnOlxuICAgICAgICAgIC8vIHBvcCB0aGUgcG9pbnQgYW5kIHByb2Nlc3MgbGF0ZXJcbiAgICAgICAgICBnZW9Qb2ludHNbZmllbGROYW1lXSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICAgIGNvbHVtbnNBcnJheS5wb3AoKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBgVHlwZSAke3NjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlfSBub3Qgc3VwcG9ydGVkIHlldGA7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjb2x1bW5zQXJyYXkgPSBjb2x1bW5zQXJyYXkuY29uY2F0KE9iamVjdC5rZXlzKGdlb1BvaW50cykpO1xuICAgIGNvbnN0IGluaXRpYWxWYWx1ZXMgPSB2YWx1ZXNBcnJheS5tYXAoKHZhbCwgaW5kZXgpID0+IHtcbiAgICAgIGxldCB0ZXJtaW5hdGlvbiA9ICcnO1xuICAgICAgY29uc3QgZmllbGROYW1lID0gY29sdW1uc0FycmF5W2luZGV4XTtcbiAgICAgIGlmIChbJ19ycGVybScsICdfd3Blcm0nXS5pbmRleE9mKGZpZWxkTmFtZSkgPj0gMCkge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6OnRleHRbXSc7XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdBcnJheSdcbiAgICAgICkge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6Ompzb25iJztcbiAgICAgIH1cbiAgICAgIHJldHVybiBgJCR7aW5kZXggKyAyICsgY29sdW1uc0FycmF5Lmxlbmd0aH0ke3Rlcm1pbmF0aW9ufWA7XG4gICAgfSk7XG4gICAgY29uc3QgZ2VvUG9pbnRzSW5qZWN0cyA9IE9iamVjdC5rZXlzKGdlb1BvaW50cykubWFwKGtleSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGdlb1BvaW50c1trZXldO1xuICAgICAgdmFsdWVzQXJyYXkucHVzaCh2YWx1ZS5sb25naXR1ZGUsIHZhbHVlLmxhdGl0dWRlKTtcbiAgICAgIGNvbnN0IGwgPSB2YWx1ZXNBcnJheS5sZW5ndGggKyBjb2x1bW5zQXJyYXkubGVuZ3RoO1xuICAgICAgcmV0dXJuIGBQT0lOVCgkJHtsfSwgJCR7bCArIDF9KWA7XG4gICAgfSk7XG5cbiAgICBjb25zdCBjb2x1bW5zUGF0dGVybiA9IGNvbHVtbnNBcnJheVxuICAgICAgLm1hcCgoY29sLCBpbmRleCkgPT4gYCQke2luZGV4ICsgMn06bmFtZWApXG4gICAgICAuam9pbigpO1xuICAgIGNvbnN0IHZhbHVlc1BhdHRlcm4gPSBpbml0aWFsVmFsdWVzLmNvbmNhdChnZW9Qb2ludHNJbmplY3RzKS5qb2luKCk7XG5cbiAgICBjb25zdCBxcyA9IGBJTlNFUlQgSU5UTyAkMTpuYW1lICgke2NvbHVtbnNQYXR0ZXJufSkgVkFMVUVTICgke3ZhbHVlc1BhdHRlcm59KWA7XG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZSwgLi4uY29sdW1uc0FycmF5LCAuLi52YWx1ZXNBcnJheV07XG4gICAgZGVidWcocXMsIHZhbHVlcyk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLm5vbmUocXMsIHZhbHVlcylcbiAgICAgIC50aGVuKCgpID0+ICh7IG9wczogW29iamVjdF0gfSkpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yKSB7XG4gICAgICAgICAgY29uc3QgZXJyID0gbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgJ0EgZHVwbGljYXRlIHZhbHVlIGZvciBhIGZpZWxkIHdpdGggdW5pcXVlIHZhbHVlcyB3YXMgcHJvdmlkZWQnXG4gICAgICAgICAgKTtcbiAgICAgICAgICBlcnIudW5kZXJseWluZ0Vycm9yID0gZXJyb3I7XG4gICAgICAgICAgaWYgKGVycm9yLmNvbnN0cmFpbnQpIHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZXMgPSBlcnJvci5jb25zdHJhaW50Lm1hdGNoKC91bmlxdWVfKFthLXpBLVpdKykvKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGVycm9yID0gZXJyO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gIH1cblxuICAvLyBSZW1vdmUgYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIC8vIElmIG5vIG9iamVjdHMgbWF0Y2gsIHJlamVjdCB3aXRoIE9CSkVDVF9OT1RfRk9VTkQuIElmIG9iamVjdHMgYXJlIGZvdW5kIGFuZCBkZWxldGVkLCByZXNvbHZlIHdpdGggdW5kZWZpbmVkLlxuICAvLyBJZiB0aGVyZSBpcyBzb21lIG90aGVyIGVycm9yLCByZWplY3Qgd2l0aCBJTlRFUk5BTF9TRVJWRVJfRVJST1IuXG4gIGRlbGV0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlXG4gICkge1xuICAgIGRlYnVnKCdkZWxldGVPYmplY3RzQnlRdWVyeScsIGNsYXNzTmFtZSwgcXVlcnkpO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IGluZGV4ID0gMjtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2UoeyBzY2hlbWEsIGluZGV4LCBxdWVyeSB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuICAgIGlmIChPYmplY3Qua2V5cyhxdWVyeSkubGVuZ3RoID09PSAwKSB7XG4gICAgICB3aGVyZS5wYXR0ZXJuID0gJ1RSVUUnO1xuICAgIH1cbiAgICBjb25zdCBxcyA9IGBXSVRIIGRlbGV0ZWQgQVMgKERFTEVURSBGUk9NICQxOm5hbWUgV0hFUkUgJHtcbiAgICAgIHdoZXJlLnBhdHRlcm5cbiAgICB9IFJFVFVSTklORyAqKSBTRUxFQ1QgY291bnQoKikgRlJPTSBkZWxldGVkYDtcbiAgICBkZWJ1ZyhxcywgdmFsdWVzKTtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50XG4gICAgICAub25lKHFzLCB2YWx1ZXMsIGEgPT4gK2EuY291bnQpXG4gICAgICAudGhlbihjb3VudCA9PiB7XG4gICAgICAgIGlmIChjb3VudCA9PT0gMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAnT2JqZWN0IG5vdCBmb3VuZC4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gY291bnQ7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgLy8gRUxTRTogRG9uJ3QgZGVsZXRlIGFueXRoaW5nIGlmIGRvZXNuJ3QgZXhpc3RcbiAgICAgIH0pO1xuICB9XG4gIC8vIFJldHVybiB2YWx1ZSBub3QgY3VycmVudGx5IHdlbGwgc3BlY2lmaWVkLlxuICBmaW5kT25lQW5kVXBkYXRlKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55XG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgZGVidWcoJ2ZpbmRPbmVBbmRVcGRhdGUnLCBjbGFzc05hbWUsIHF1ZXJ5LCB1cGRhdGUpO1xuICAgIHJldHVybiB0aGlzLnVwZGF0ZU9iamVjdHNCeVF1ZXJ5KGNsYXNzTmFtZSwgc2NoZW1hLCBxdWVyeSwgdXBkYXRlKS50aGVuKFxuICAgICAgdmFsID0+IHZhbFswXVxuICAgICk7XG4gIH1cblxuICAvLyBBcHBseSB0aGUgdXBkYXRlIHRvIGFsbCBvYmplY3RzIHRoYXQgbWF0Y2ggdGhlIGdpdmVuIFBhcnNlIFF1ZXJ5LlxuICB1cGRhdGVPYmplY3RzQnlRdWVyeShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueVxuICApOiBQcm9taXNlPFthbnldPiB7XG4gICAgZGVidWcoJ3VwZGF0ZU9iamVjdHNCeVF1ZXJ5JywgY2xhc3NOYW1lLCBxdWVyeSwgdXBkYXRlKTtcbiAgICBjb25zdCB1cGRhdGVQYXR0ZXJucyA9IFtdO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGxldCBpbmRleCA9IDI7XG4gICAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuXG4gICAgY29uc3Qgb3JpZ2luYWxVcGRhdGUgPSB7IC4uLnVwZGF0ZSB9O1xuXG4gICAgLy8gU2V0IGZsYWcgZm9yIGRvdCBub3RhdGlvbiBmaWVsZHNcbiAgICBjb25zdCBkb3ROb3RhdGlvbk9wdGlvbnMgPSB7fTtcbiAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID4gLTEpIHtcbiAgICAgICAgY29uc3QgY29tcG9uZW50cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBjb25zdCBmaXJzdCA9IGNvbXBvbmVudHMuc2hpZnQoKTtcbiAgICAgICAgZG90Tm90YXRpb25PcHRpb25zW2ZpcnN0XSA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkb3ROb3RhdGlvbk9wdGlvbnNbZmllbGROYW1lXSA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHVwZGF0ZSA9IGhhbmRsZURvdEZpZWxkcyh1cGRhdGUpO1xuICAgIC8vIFJlc29sdmUgYXV0aERhdGEgZmlyc3QsXG4gICAgLy8gU28gd2UgZG9uJ3QgZW5kIHVwIHdpdGggbXVsdGlwbGUga2V5IHVwZGF0ZXNcbiAgICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiB1cGRhdGUpIHtcbiAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBmaWVsZE5hbWUubWF0Y2goL15fYXV0aF9kYXRhXyhbYS16QS1aMC05X10rKSQvKTtcbiAgICAgIGlmIChhdXRoRGF0YU1hdGNoKSB7XG4gICAgICAgIHZhciBwcm92aWRlciA9IGF1dGhEYXRhTWF0Y2hbMV07XG4gICAgICAgIGNvbnN0IHZhbHVlID0gdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICAgIGRlbGV0ZSB1cGRhdGVbZmllbGROYW1lXTtcbiAgICAgICAgdXBkYXRlWydhdXRoRGF0YSddID0gdXBkYXRlWydhdXRoRGF0YSddIHx8IHt9O1xuICAgICAgICB1cGRhdGVbJ2F1dGhEYXRhJ11bcHJvdmlkZXJdID0gdmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gdXBkYXRlKSB7XG4gICAgICBjb25zdCBmaWVsZFZhbHVlID0gdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICAvLyBEcm9wIGFueSB1bmRlZmluZWQgdmFsdWVzLlxuICAgICAgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICBkZWxldGUgdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSBOVUxMYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkTmFtZSA9PSAnYXV0aERhdGEnKSB7XG4gICAgICAgIC8vIFRoaXMgcmVjdXJzaXZlbHkgc2V0cyB0aGUganNvbl9vYmplY3RcbiAgICAgICAgLy8gT25seSAxIGxldmVsIGRlZXBcbiAgICAgICAgY29uc3QgZ2VuZXJhdGUgPSAoanNvbmI6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiBhbnkpID0+IHtcbiAgICAgICAgICByZXR1cm4gYGpzb25fb2JqZWN0X3NldF9rZXkoQ09BTEVTQ0UoJHtqc29uYn0sICd7fSc6Ompzb25iKSwgJHtrZXl9LCAke3ZhbHVlfSk6Ompzb25iYDtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgbGFzdEtleSA9IGAkJHtpbmRleH06bmFtZWA7XG4gICAgICAgIGNvbnN0IGZpZWxkTmFtZUluZGV4ID0gaW5kZXg7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIGNvbnN0IHVwZGF0ZSA9IE9iamVjdC5rZXlzKGZpZWxkVmFsdWUpLnJlZHVjZShcbiAgICAgICAgICAobGFzdEtleTogc3RyaW5nLCBrZXk6IHN0cmluZykgPT4ge1xuICAgICAgICAgICAgY29uc3Qgc3RyID0gZ2VuZXJhdGUoXG4gICAgICAgICAgICAgIGxhc3RLZXksXG4gICAgICAgICAgICAgIGAkJHtpbmRleH06OnRleHRgLFxuICAgICAgICAgICAgICBgJCR7aW5kZXggKyAxfTo6anNvbmJgXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgIGxldCB2YWx1ZSA9IGZpZWxkVmFsdWVba2V5XTtcbiAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICBpZiAodmFsdWUuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZSA9IG51bGw7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdmFsdWUgPSBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGtleSwgdmFsdWUpO1xuICAgICAgICAgICAgcmV0dXJuIHN0cjtcbiAgICAgICAgICB9LFxuICAgICAgICAgIGxhc3RLZXlcbiAgICAgICAgKTtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7ZmllbGROYW1lSW5kZXh9Om5hbWUgPSAke3VwZGF0ZX1gKTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnSW5jcmVtZW50Jykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKFxuICAgICAgICAgIGAkJHtpbmRleH06bmFtZSA9IENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAwKSArICQke2luZGV4ICsgMX1gXG4gICAgICAgICk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5hbW91bnQpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fb3AgPT09ICdBZGQnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goXG4gICAgICAgICAgYCQke2luZGV4fTpuYW1lID0gYXJyYXlfYWRkKENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAnW10nOjpqc29uYiksICQke2luZGV4ICtcbiAgICAgICAgICAgIDF9Ojpqc29uYilgXG4gICAgICAgICk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZS5vYmplY3RzKSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgbnVsbCk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX19vcCA9PT0gJ1JlbW92ZScpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChcbiAgICAgICAgICBgJCR7aW5kZXh9Om5hbWUgPSBhcnJheV9yZW1vdmUoQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUsICdbXSc6Ompzb25iKSwgJCR7aW5kZXggK1xuICAgICAgICAgICAgMX06Ompzb25iKWBcbiAgICAgICAgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLm9iamVjdHMpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnQWRkVW5pcXVlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKFxuICAgICAgICAgIGAkJHtpbmRleH06bmFtZSA9IGFycmF5X2FkZF91bmlxdWUoQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUsICdbXSc6Ompzb25iKSwgJCR7aW5kZXggK1xuICAgICAgICAgICAgMX06Ompzb25iKWBcbiAgICAgICAgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLm9iamVjdHMpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGROYW1lID09PSAndXBkYXRlZEF0Jykge1xuICAgICAgICAvL1RPRE86IHN0b3Agc3BlY2lhbCBjYXNpbmcgdGhpcy4gSXQgc2hvdWxkIGNoZWNrIGZvciBfX3R5cGUgPT09ICdEYXRlJyBhbmQgdXNlIC5pc29cbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdib29sZWFuJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLm9iamVjdElkKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCB0b1Bvc3RncmVzVmFsdWUoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdGaWxlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCB0b1Bvc3RncmVzVmFsdWUoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ0dlb1BvaW50Jykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKFxuICAgICAgICAgIGAkJHtpbmRleH06bmFtZSA9IFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pYFxuICAgICAgICApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUubG9uZ2l0dWRlLCBmaWVsZFZhbHVlLmxhdGl0dWRlKTtcbiAgICAgICAgaW5kZXggKz0gMztcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGNvbnZlcnRQb2x5Z29uVG9TUUwoZmllbGRWYWx1ZS5jb29yZGluYXRlcyk7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfTo6cG9seWdvbmApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIHZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgLy8gbm9vcFxuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICB0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnT2JqZWN0J1xuICAgICAgKSB7XG4gICAgICAgIC8vIEdhdGhlciBrZXlzIHRvIGluY3JlbWVudFxuICAgICAgICBjb25zdCBrZXlzVG9JbmNyZW1lbnQgPSBPYmplY3Qua2V5cyhvcmlnaW5hbFVwZGF0ZSlcbiAgICAgICAgICAuZmlsdGVyKGsgPT4ge1xuICAgICAgICAgICAgLy8gY2hvb3NlIHRvcCBsZXZlbCBmaWVsZHMgdGhhdCBoYXZlIGEgZGVsZXRlIG9wZXJhdGlvbiBzZXRcbiAgICAgICAgICAgIC8vIE5vdGUgdGhhdCBPYmplY3Qua2V5cyBpcyBpdGVyYXRpbmcgb3ZlciB0aGUgKipvcmlnaW5hbCoqIHVwZGF0ZSBvYmplY3RcbiAgICAgICAgICAgIC8vIGFuZCB0aGF0IHNvbWUgb2YgdGhlIGtleXMgb2YgdGhlIG9yaWdpbmFsIHVwZGF0ZSBjb3VsZCBiZSBudWxsIG9yIHVuZGVmaW5lZDpcbiAgICAgICAgICAgIC8vIChTZWUgdGhlIGFib3ZlIGNoZWNrIGBpZiAoZmllbGRWYWx1ZSA9PT0gbnVsbCB8fCB0eXBlb2YgZmllbGRWYWx1ZSA9PSBcInVuZGVmaW5lZFwiKWApXG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IG9yaWdpbmFsVXBkYXRlW2tdO1xuICAgICAgICAgICAgcmV0dXJuIChcbiAgICAgICAgICAgICAgdmFsdWUgJiZcbiAgICAgICAgICAgICAgdmFsdWUuX19vcCA9PT0gJ0luY3JlbWVudCcgJiZcbiAgICAgICAgICAgICAgay5zcGxpdCgnLicpLmxlbmd0aCA9PT0gMiAmJlxuICAgICAgICAgICAgICBrLnNwbGl0KCcuJylbMF0gPT09IGZpZWxkTmFtZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5tYXAoayA9PiBrLnNwbGl0KCcuJylbMV0pO1xuXG4gICAgICAgIGxldCBpbmNyZW1lbnRQYXR0ZXJucyA9ICcnO1xuICAgICAgICBpZiAoa2V5c1RvSW5jcmVtZW50Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBpbmNyZW1lbnRQYXR0ZXJucyA9XG4gICAgICAgICAgICAnIHx8ICcgK1xuICAgICAgICAgICAga2V5c1RvSW5jcmVtZW50XG4gICAgICAgICAgICAgIC5tYXAoYyA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgYW1vdW50ID0gZmllbGRWYWx1ZVtjXS5hbW91bnQ7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGBDT05DQVQoJ3tcIiR7Y31cIjonLCBDT0FMRVNDRSgkJHtpbmRleH06bmFtZS0+Picke2N9JywnMCcpOjppbnQgKyAke2Ftb3VudH0sICd9Jyk6Ompzb25iYDtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmpvaW4oJyB8fCAnKTtcbiAgICAgICAgICAvLyBTdHJpcCB0aGUga2V5c1xuICAgICAgICAgIGtleXNUb0luY3JlbWVudC5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgICAgICBkZWxldGUgZmllbGRWYWx1ZVtrZXldO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qga2V5c1RvRGVsZXRlOiBBcnJheTxzdHJpbmc+ID0gT2JqZWN0LmtleXMob3JpZ2luYWxVcGRhdGUpXG4gICAgICAgICAgLmZpbHRlcihrID0+IHtcbiAgICAgICAgICAgIC8vIGNob29zZSB0b3AgbGV2ZWwgZmllbGRzIHRoYXQgaGF2ZSBhIGRlbGV0ZSBvcGVyYXRpb24gc2V0LlxuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBvcmlnaW5hbFVwZGF0ZVtrXTtcbiAgICAgICAgICAgIHJldHVybiAoXG4gICAgICAgICAgICAgIHZhbHVlICYmXG4gICAgICAgICAgICAgIHZhbHVlLl9fb3AgPT09ICdEZWxldGUnICYmXG4gICAgICAgICAgICAgIGsuc3BsaXQoJy4nKS5sZW5ndGggPT09IDIgJiZcbiAgICAgICAgICAgICAgay5zcGxpdCgnLicpWzBdID09PSBmaWVsZE5hbWVcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAubWFwKGsgPT4gay5zcGxpdCgnLicpWzFdKTtcblxuICAgICAgICBjb25zdCBkZWxldGVQYXR0ZXJucyA9IGtleXNUb0RlbGV0ZS5yZWR1Y2UoXG4gICAgICAgICAgKHA6IHN0cmluZywgYzogc3RyaW5nLCBpOiBudW1iZXIpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBwICsgYCAtICckJHtpbmRleCArIDEgKyBpfTp2YWx1ZSdgO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgJydcbiAgICAgICAgKTtcbiAgICAgICAgLy8gT3ZlcnJpZGUgT2JqZWN0XG4gICAgICAgIGxldCB1cGRhdGVPYmplY3QgPSBcIid7fSc6Ompzb25iXCI7XG5cbiAgICAgICAgaWYgKGRvdE5vdGF0aW9uT3B0aW9uc1tmaWVsZE5hbWVdKSB7XG4gICAgICAgICAgLy8gTWVyZ2UgT2JqZWN0XG4gICAgICAgICAgdXBkYXRlT2JqZWN0ID0gYENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAne30nOjpqc29uYilgO1xuICAgICAgICB9XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goXG4gICAgICAgICAgYCQke2luZGV4fTpuYW1lID0gKCR7dXBkYXRlT2JqZWN0fSAke2RlbGV0ZVBhdHRlcm5zfSAke2luY3JlbWVudFBhdHRlcm5zfSB8fCAkJHtpbmRleCArXG4gICAgICAgICAgICAxICtcbiAgICAgICAgICAgIGtleXNUb0RlbGV0ZS5sZW5ndGh9Ojpqc29uYiApYFxuICAgICAgICApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIC4uLmtleXNUb0RlbGV0ZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyICsga2V5c1RvRGVsZXRlLmxlbmd0aDtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIEFycmF5LmlzQXJyYXkoZmllbGRWYWx1ZSkgJiZcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdICYmXG4gICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnQXJyYXknXG4gICAgICApIHtcbiAgICAgICAgY29uc3QgZXhwZWN0ZWRUeXBlID0gcGFyc2VUeXBlVG9Qb3N0Z3Jlc1R5cGUoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdKTtcbiAgICAgICAgaWYgKGV4cGVjdGVkVHlwZSA9PT0gJ3RleHRbXScpIHtcbiAgICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX06OnRleHRbXWApO1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgIGNvbnN0IGJ1aWxkU1FMQXJyYXkgPSBmaWVsZFZhbHVlID0+IHtcbiAgICAgICAgICAgIGxldCBwYXR0ZXJuID0gJ2pzb25fYnVpbGRfYXJyYXkoJztcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRWYWx1ZS5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgICAgICAgICBjb25zdCBlbGVtZW50ID0gZmllbGRWYWx1ZVtpXTtcbiAgICAgICAgICAgICAgbGV0IHR5cGUgPSAnJztcbiAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZWxlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBwYXR0ZXJuICs9IGJ1aWxkU1FMQXJyYXkoZWxlbWVudCkgKyAnLCc7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGVsZW1lbnQgPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gJzo6anNvbic7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdmFsdWVzLnB1c2goZWxlbWVudCk7XG4gICAgICAgICAgICAgIHBhdHRlcm4gKz0gYCQke2luZGV4ICsgMX0ke3R5cGV9LGA7XG4gICAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyByZW1vdmUgbGFzdCBjb21tYVxuICAgICAgICAgICAgaWYgKGZpZWxkVmFsdWUubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICBwYXR0ZXJuID0gcGF0dGVybi5zbGljZSgwLCAtMSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBwYXR0ZXJuICs9ICcpJztcbiAgICAgICAgICAgIHJldHVybiBwYXR0ZXJuO1xuICAgICAgICAgIH07XG4gICAgICAgICAgY29uc3Qgc3FsID0gYCQke2luZGV4fTpuYW1lID0gJHtidWlsZFNRTEFycmF5KGZpZWxkVmFsdWUpfWA7XG5cbiAgICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKHNxbCk7XG4gICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGVidWcoJ05vdCBzdXBwb3J0ZWQgdXBkYXRlJywgZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICBgUG9zdGdyZXMgZG9lc24ndCBzdXBwb3J0IHVwZGF0ZSAke0pTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpfSB5ZXRgXG4gICAgICAgICAgKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHdoZXJlID0gYnVpbGRXaGVyZUNsYXVzZSh7IHNjaGVtYSwgaW5kZXgsIHF1ZXJ5IH0pO1xuICAgIHZhbHVlcy5wdXNoKC4uLndoZXJlLnZhbHVlcyk7XG5cbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9XG4gICAgICB3aGVyZS5wYXR0ZXJuLmxlbmd0aCA+IDAgPyBgV0hFUkUgJHt3aGVyZS5wYXR0ZXJufWAgOiAnJztcbiAgICBjb25zdCBxcyA9IGBVUERBVEUgJDE6bmFtZSBTRVQgJHt1cGRhdGVQYXR0ZXJucy5qb2luKCl9ICR7d2hlcmVDbGF1c2V9IFJFVFVSTklORyAqYDtcbiAgICBkZWJ1ZygndXBkYXRlOiAnLCBxcywgdmFsdWVzKTtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50LmFueShxcywgdmFsdWVzKTtcbiAgfVxuXG4gIC8vIEhvcGVmdWxseSwgd2UgY2FuIGdldCByaWQgb2YgdGhpcy4gSXQncyBvbmx5IHVzZWQgZm9yIGNvbmZpZyBhbmQgaG9va3MuXG4gIHVwc2VydE9uZU9iamVjdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueVxuICApIHtcbiAgICBkZWJ1ZygndXBzZXJ0T25lT2JqZWN0JywgeyBjbGFzc05hbWUsIHF1ZXJ5LCB1cGRhdGUgfSk7XG4gICAgY29uc3QgY3JlYXRlVmFsdWUgPSBPYmplY3QuYXNzaWduKHt9LCBxdWVyeSwgdXBkYXRlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVPYmplY3QoY2xhc3NOYW1lLCBzY2hlbWEsIGNyZWF0ZVZhbHVlKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICAvLyBpZ25vcmUgZHVwbGljYXRlIHZhbHVlIGVycm9ycyBhcyBpdCdzIHVwc2VydFxuICAgICAgaWYgKGVycm9yLmNvZGUgIT09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSkge1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLmZpbmRPbmVBbmRVcGRhdGUoY2xhc3NOYW1lLCBzY2hlbWEsIHF1ZXJ5LCB1cGRhdGUpO1xuICAgIH0pO1xuICB9XG5cbiAgZmluZChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB7IHNraXAsIGxpbWl0LCBzb3J0LCBrZXlzIH06IFF1ZXJ5T3B0aW9uc1xuICApIHtcbiAgICBkZWJ1ZygnZmluZCcsIGNsYXNzTmFtZSwgcXVlcnksIHsgc2tpcCwgbGltaXQsIHNvcnQsIGtleXMgfSk7XG4gICAgY29uc3QgaGFzTGltaXQgPSBsaW1pdCAhPT0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGhhc1NraXAgPSBza2lwICE9PSB1bmRlZmluZWQ7XG4gICAgbGV0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IHdoZXJlID0gYnVpbGRXaGVyZUNsYXVzZSh7IHNjaGVtYSwgcXVlcnksIGluZGV4OiAyIH0pO1xuICAgIHZhbHVlcy5wdXNoKC4uLndoZXJlLnZhbHVlcyk7XG5cbiAgICBjb25zdCB3aGVyZVBhdHRlcm4gPVxuICAgICAgd2hlcmUucGF0dGVybi5sZW5ndGggPiAwID8gYFdIRVJFICR7d2hlcmUucGF0dGVybn1gIDogJyc7XG4gICAgY29uc3QgbGltaXRQYXR0ZXJuID0gaGFzTGltaXQgPyBgTElNSVQgJCR7dmFsdWVzLmxlbmd0aCArIDF9YCA6ICcnO1xuICAgIGlmIChoYXNMaW1pdCkge1xuICAgICAgdmFsdWVzLnB1c2gobGltaXQpO1xuICAgIH1cbiAgICBjb25zdCBza2lwUGF0dGVybiA9IGhhc1NraXAgPyBgT0ZGU0VUICQke3ZhbHVlcy5sZW5ndGggKyAxfWAgOiAnJztcbiAgICBpZiAoaGFzU2tpcCkge1xuICAgICAgdmFsdWVzLnB1c2goc2tpcCk7XG4gICAgfVxuXG4gICAgbGV0IHNvcnRQYXR0ZXJuID0gJyc7XG4gICAgaWYgKHNvcnQpIHtcbiAgICAgIGNvbnN0IHNvcnRDb3B5OiBhbnkgPSBzb3J0O1xuICAgICAgY29uc3Qgc29ydGluZyA9IE9iamVjdC5rZXlzKHNvcnQpXG4gICAgICAgIC5tYXAoa2V5ID0+IHtcbiAgICAgICAgICBjb25zdCB0cmFuc2Zvcm1LZXkgPSB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyhrZXkpLmpvaW4oJy0+Jyk7XG4gICAgICAgICAgLy8gVXNpbmcgJGlkeCBwYXR0ZXJuIGdpdmVzOiAgbm9uLWludGVnZXIgY29uc3RhbnQgaW4gT1JERVIgQllcbiAgICAgICAgICBpZiAoc29ydENvcHlba2V5XSA9PT0gMSkge1xuICAgICAgICAgICAgcmV0dXJuIGAke3RyYW5zZm9ybUtleX0gQVNDYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGAke3RyYW5zZm9ybUtleX0gREVTQ2A7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCk7XG4gICAgICBzb3J0UGF0dGVybiA9XG4gICAgICAgIHNvcnQgIT09IHVuZGVmaW5lZCAmJiBPYmplY3Qua2V5cyhzb3J0KS5sZW5ndGggPiAwXG4gICAgICAgICAgPyBgT1JERVIgQlkgJHtzb3J0aW5nfWBcbiAgICAgICAgICA6ICcnO1xuICAgIH1cbiAgICBpZiAod2hlcmUuc29ydHMgJiYgT2JqZWN0LmtleXMoKHdoZXJlLnNvcnRzOiBhbnkpKS5sZW5ndGggPiAwKSB7XG4gICAgICBzb3J0UGF0dGVybiA9IGBPUkRFUiBCWSAke3doZXJlLnNvcnRzLmpvaW4oKX1gO1xuICAgIH1cblxuICAgIGxldCBjb2x1bW5zID0gJyonO1xuICAgIGlmIChrZXlzKSB7XG4gICAgICAvLyBFeGNsdWRlIGVtcHR5IGtleXNcbiAgICAgIC8vIFJlcGxhY2UgQUNMIGJ5IGl0J3Mga2V5c1xuICAgICAga2V5cyA9IGtleXMucmVkdWNlKChtZW1vLCBrZXkpID0+IHtcbiAgICAgICAgaWYgKGtleSA9PT0gJ0FDTCcpIHtcbiAgICAgICAgICBtZW1vLnB1c2goJ19ycGVybScpO1xuICAgICAgICAgIG1lbW8ucHVzaCgnX3dwZXJtJyk7XG4gICAgICAgIH0gZWxzZSBpZiAoa2V5Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBtZW1vLnB1c2goa2V5KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgIH0sIFtdKTtcbiAgICAgIGNvbHVtbnMgPSBrZXlzXG4gICAgICAgIC5tYXAoKGtleSwgaW5kZXgpID0+IHtcbiAgICAgICAgICBpZiAoa2V5ID09PSAnJHNjb3JlJykge1xuICAgICAgICAgICAgcmV0dXJuIGB0c19yYW5rX2NkKHRvX3RzdmVjdG9yKCQkezJ9LCAkJHszfTpuYW1lKSwgdG9fdHNxdWVyeSgkJHs0fSwgJCR7NX0pLCAzMikgYXMgc2NvcmVgO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gYCQke2luZGV4ICsgdmFsdWVzLmxlbmd0aCArIDF9Om5hbWVgO1xuICAgICAgICB9KVxuICAgICAgICAuam9pbigpO1xuICAgICAgdmFsdWVzID0gdmFsdWVzLmNvbmNhdChrZXlzKTtcbiAgICB9XG5cbiAgICBjb25zdCBxcyA9IGBTRUxFQ1QgJHtjb2x1bW5zfSBGUk9NICQxOm5hbWUgJHt3aGVyZVBhdHRlcm59ICR7c29ydFBhdHRlcm59ICR7bGltaXRQYXR0ZXJufSAke3NraXBQYXR0ZXJufWA7XG4gICAgZGVidWcocXMsIHZhbHVlcyk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLmFueShxcywgdmFsdWVzKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgLy8gUXVlcnkgb24gbm9uIGV4aXN0aW5nIHRhYmxlLCBkb24ndCBjcmFzaFxuICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHJlc3VsdHMgPT5cbiAgICAgICAgcmVzdWx0cy5tYXAob2JqZWN0ID0+XG4gICAgICAgICAgdGhpcy5wb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSlcbiAgICAgICAgKVxuICAgICAgKTtcbiAgfVxuXG4gIC8vIENvbnZlcnRzIGZyb20gYSBwb3N0Z3Jlcy1mb3JtYXQgb2JqZWN0IHRvIGEgUkVTVC1mb3JtYXQgb2JqZWN0LlxuICAvLyBEb2VzIG5vdCBzdHJpcCBvdXQgYW55dGhpbmcgYmFzZWQgb24gYSBsYWNrIG9mIGF1dGhlbnRpY2F0aW9uLlxuICBwb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lOiBzdHJpbmcsIG9iamVjdDogYW55LCBzY2hlbWE6IGFueSkge1xuICAgIE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInICYmIG9iamVjdFtmaWVsZE5hbWVdKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIG9iamVjdElkOiBvYmplY3RbZmllbGROYW1lXSxcbiAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICBjbGFzc05hbWU6IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50YXJnZXRDbGFzcyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX3R5cGU6ICdSZWxhdGlvbicsXG4gICAgICAgICAgY2xhc3NOYW1lOiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udGFyZ2V0Q2xhc3MsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdHZW9Qb2ludCcpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX190eXBlOiAnR2VvUG9pbnQnLFxuICAgICAgICAgIGxhdGl0dWRlOiBvYmplY3RbZmllbGROYW1lXS55LFxuICAgICAgICAgIGxvbmdpdHVkZTogb2JqZWN0W2ZpZWxkTmFtZV0ueCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGxldCBjb29yZHMgPSBvYmplY3RbZmllbGROYW1lXTtcbiAgICAgICAgY29vcmRzID0gY29vcmRzLnN1YnN0cigyLCBjb29yZHMubGVuZ3RoIC0gNCkuc3BsaXQoJyksKCcpO1xuICAgICAgICBjb29yZHMgPSBjb29yZHMubWFwKHBvaW50ID0+IHtcbiAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgcGFyc2VGbG9hdChwb2ludC5zcGxpdCgnLCcpWzFdKSxcbiAgICAgICAgICAgIHBhcnNlRmxvYXQocG9pbnQuc3BsaXQoJywnKVswXSksXG4gICAgICAgICAgXTtcbiAgICAgICAgfSk7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogJ1BvbHlnb24nLFxuICAgICAgICAgIGNvb3JkaW5hdGVzOiBjb29yZHMsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdGaWxlJykge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX3R5cGU6ICdGaWxlJyxcbiAgICAgICAgICBuYW1lOiBvYmplY3RbZmllbGROYW1lXSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvL1RPRE86IHJlbW92ZSB0aGlzIHJlbGlhbmNlIG9uIHRoZSBtb25nbyBmb3JtYXQuIERCIGFkYXB0ZXIgc2hvdWxkbid0IGtub3cgdGhlcmUgaXMgYSBkaWZmZXJlbmNlIGJldHdlZW4gY3JlYXRlZCBhdCBhbmQgYW55IG90aGVyIGRhdGUgZmllbGQuXG4gICAgaWYgKG9iamVjdC5jcmVhdGVkQXQpIHtcbiAgICAgIG9iamVjdC5jcmVhdGVkQXQgPSBvYmplY3QuY3JlYXRlZEF0LnRvSVNPU3RyaW5nKCk7XG4gICAgfVxuICAgIGlmIChvYmplY3QudXBkYXRlZEF0KSB7XG4gICAgICBvYmplY3QudXBkYXRlZEF0ID0gb2JqZWN0LnVwZGF0ZWRBdC50b0lTT1N0cmluZygpO1xuICAgIH1cbiAgICBpZiAob2JqZWN0LmV4cGlyZXNBdCkge1xuICAgICAgb2JqZWN0LmV4cGlyZXNBdCA9IHtcbiAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgIGlzbzogb2JqZWN0LmV4cGlyZXNBdC50b0lTT1N0cmluZygpLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5fZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQpIHtcbiAgICAgIG9iamVjdC5fZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQgPSB7XG4gICAgICAgIF9fdHlwZTogJ0RhdGUnLFxuICAgICAgICBpc286IG9iamVjdC5fZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQudG9JU09TdHJpbmcoKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChvYmplY3QuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0KSB7XG4gICAgICBvYmplY3QuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0ID0ge1xuICAgICAgICBfX3R5cGU6ICdEYXRlJyxcbiAgICAgICAgaXNvOiBvYmplY3QuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0LnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAob2JqZWN0Ll9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQpIHtcbiAgICAgIG9iamVjdC5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0ID0ge1xuICAgICAgICBfX3R5cGU6ICdEYXRlJyxcbiAgICAgICAgaXNvOiBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdC50b0lTT1N0cmluZygpLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5fcGFzc3dvcmRfY2hhbmdlZF9hdCkge1xuICAgICAgb2JqZWN0Ll9wYXNzd29yZF9jaGFuZ2VkX2F0ID0ge1xuICAgICAgICBfX3R5cGU6ICdEYXRlJyxcbiAgICAgICAgaXNvOiBvYmplY3QuX3Bhc3N3b3JkX2NoYW5nZWRfYXQudG9JU09TdHJpbmcoKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gb2JqZWN0KSB7XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0gPT09IG51bGwpIHtcbiAgICAgICAgZGVsZXRlIG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgfVxuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX3R5cGU6ICdEYXRlJyxcbiAgICAgICAgICBpc286IG9iamVjdFtmaWVsZE5hbWVdLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIC8vIENyZWF0ZSBhIHVuaXF1ZSBpbmRleC4gVW5pcXVlIGluZGV4ZXMgb24gbnVsbGFibGUgZmllbGRzIGFyZSBub3QgYWxsb3dlZC4gU2luY2Ugd2UgZG9uJ3RcbiAgLy8gY3VycmVudGx5IGtub3cgd2hpY2ggZmllbGRzIGFyZSBudWxsYWJsZSBhbmQgd2hpY2ggYXJlbid0LCB3ZSBpZ25vcmUgdGhhdCBjcml0ZXJpYS5cbiAgLy8gQXMgc3VjaCwgd2Ugc2hvdWxkbid0IGV4cG9zZSB0aGlzIGZ1bmN0aW9uIHRvIHVzZXJzIG9mIHBhcnNlIHVudGlsIHdlIGhhdmUgYW4gb3V0LW9mLWJhbmRcbiAgLy8gV2F5IG9mIGRldGVybWluaW5nIGlmIGEgZmllbGQgaXMgbnVsbGFibGUuIFVuZGVmaW5lZCBkb2Vzbid0IGNvdW50IGFnYWluc3QgdW5pcXVlbmVzcyxcbiAgLy8gd2hpY2ggaXMgd2h5IHdlIHVzZSBzcGFyc2UgaW5kZXhlcy5cbiAgZW5zdXJlVW5pcXVlbmVzcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgZmllbGROYW1lczogc3RyaW5nW11cbiAgKSB7XG4gICAgLy8gVXNlIHRoZSBzYW1lIG5hbWUgZm9yIGV2ZXJ5IGVuc3VyZVVuaXF1ZW5lc3MgYXR0ZW1wdCwgYmVjYXVzZSBwb3N0Z3Jlc1xuICAgIC8vIFdpbGwgaGFwcGlseSBjcmVhdGUgdGhlIHNhbWUgaW5kZXggd2l0aCBtdWx0aXBsZSBuYW1lcy5cbiAgICBjb25zdCBjb25zdHJhaW50TmFtZSA9IGB1bmlxdWVfJHtmaWVsZE5hbWVzLnNvcnQoKS5qb2luKCdfJyl9YDtcbiAgICBjb25zdCBjb25zdHJhaW50UGF0dGVybnMgPSBmaWVsZE5hbWVzLm1hcChcbiAgICAgIChmaWVsZE5hbWUsIGluZGV4KSA9PiBgJCR7aW5kZXggKyAzfTpuYW1lYFxuICAgICk7XG4gICAgY29uc3QgcXMgPSBgQUxURVIgVEFCTEUgJDE6bmFtZSBBREQgQ09OU1RSQUlOVCAkMjpuYW1lIFVOSVFVRSAoJHtjb25zdHJhaW50UGF0dGVybnMuam9pbigpfSlgO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnRcbiAgICAgIC5ub25lKHFzLCBbY2xhc3NOYW1lLCBjb25zdHJhaW50TmFtZSwgLi4uZmllbGROYW1lc10pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yICYmXG4gICAgICAgICAgZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhjb25zdHJhaW50TmFtZSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgLy8gSW5kZXggYWxyZWFkeSBleGlzdHMuIElnbm9yZSBlcnJvci5cbiAgICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgICBlcnJvci5jb2RlID09PSBQb3N0Z3Jlc1VuaXF1ZUluZGV4VmlvbGF0aW9uRXJyb3IgJiZcbiAgICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGNvbnN0cmFpbnROYW1lKVxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBDYXN0IHRoZSBlcnJvciBpbnRvIHRoZSBwcm9wZXIgcGFyc2UgZXJyb3JcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsXG4gICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIEV4ZWN1dGVzIGEgY291bnQuXG4gIGNvdW50KGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIHF1ZXJ5OiBRdWVyeVR5cGUpIHtcbiAgICBkZWJ1ZygnY291bnQnLCBjbGFzc05hbWUsIHF1ZXJ5KTtcbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lXTtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2UoeyBzY2hlbWEsIHF1ZXJ5LCBpbmRleDogMiB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVQYXR0ZXJuID1cbiAgICAgIHdoZXJlLnBhdHRlcm4ubGVuZ3RoID4gMCA/IGBXSEVSRSAke3doZXJlLnBhdHRlcm59YCA6ICcnO1xuICAgIGNvbnN0IHFzID0gYFNFTEVDVCBjb3VudCgqKSBGUk9NICQxOm5hbWUgJHt3aGVyZVBhdHRlcm59YDtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50Lm9uZShxcywgdmFsdWVzLCBhID0+ICthLmNvdW50KS5jYXRjaChlcnJvciA9PiB7XG4gICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgICAgcmV0dXJuIDA7XG4gICAgfSk7XG4gIH1cblxuICBkaXN0aW5jdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICBmaWVsZE5hbWU6IHN0cmluZ1xuICApIHtcbiAgICBkZWJ1ZygnZGlzdGluY3QnLCBjbGFzc05hbWUsIHF1ZXJ5KTtcbiAgICBsZXQgZmllbGQgPSBmaWVsZE5hbWU7XG4gICAgbGV0IGNvbHVtbiA9IGZpZWxkTmFtZTtcbiAgICBjb25zdCBpc05lc3RlZCA9IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPj0gMDtcbiAgICBpZiAoaXNOZXN0ZWQpIHtcbiAgICAgIGZpZWxkID0gdHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMoZmllbGROYW1lKS5qb2luKCctPicpO1xuICAgICAgY29sdW1uID0gZmllbGROYW1lLnNwbGl0KCcuJylbMF07XG4gICAgfVxuICAgIGNvbnN0IGlzQXJyYXlGaWVsZCA9XG4gICAgICBzY2hlbWEuZmllbGRzICYmXG4gICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnQXJyYXknO1xuICAgIGNvbnN0IGlzUG9pbnRlckZpZWxkID1cbiAgICAgIHNjaGVtYS5maWVsZHMgJiZcbiAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdQb2ludGVyJztcbiAgICBjb25zdCB2YWx1ZXMgPSBbZmllbGQsIGNvbHVtbiwgY2xhc3NOYW1lXTtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2UoeyBzY2hlbWEsIHF1ZXJ5LCBpbmRleDogNCB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVQYXR0ZXJuID1cbiAgICAgIHdoZXJlLnBhdHRlcm4ubGVuZ3RoID4gMCA/IGBXSEVSRSAke3doZXJlLnBhdHRlcm59YCA6ICcnO1xuICAgIGNvbnN0IHRyYW5zZm9ybWVyID0gaXNBcnJheUZpZWxkID8gJ2pzb25iX2FycmF5X2VsZW1lbnRzJyA6ICdPTic7XG4gICAgbGV0IHFzID0gYFNFTEVDVCBESVNUSU5DVCAke3RyYW5zZm9ybWVyfSgkMTpuYW1lKSAkMjpuYW1lIEZST00gJDM6bmFtZSAke3doZXJlUGF0dGVybn1gO1xuICAgIGlmIChpc05lc3RlZCkge1xuICAgICAgcXMgPSBgU0VMRUNUIERJU1RJTkNUICR7dHJhbnNmb3JtZXJ9KCQxOnJhdykgJDI6cmF3IEZST00gJDM6bmFtZSAke3doZXJlUGF0dGVybn1gO1xuICAgIH1cbiAgICBkZWJ1ZyhxcywgdmFsdWVzKTtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50XG4gICAgICAuYW55KHFzLCB2YWx1ZXMpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNNaXNzaW5nQ29sdW1uRXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4gW107XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmICghaXNOZXN0ZWQpIHtcbiAgICAgICAgICByZXN1bHRzID0gcmVzdWx0cy5maWx0ZXIob2JqZWN0ID0+IG9iamVjdFtmaWVsZF0gIT09IG51bGwpO1xuICAgICAgICAgIHJldHVybiByZXN1bHRzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgICAgaWYgKCFpc1BvaW50ZXJGaWVsZCkge1xuICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0W2ZpZWxkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50YXJnZXRDbGFzcyxcbiAgICAgICAgICAgICAgb2JqZWN0SWQ6IG9iamVjdFtmaWVsZF0sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNoaWxkID0gZmllbGROYW1lLnNwbGl0KCcuJylbMV07XG4gICAgICAgIHJldHVybiByZXN1bHRzLm1hcChvYmplY3QgPT4gb2JqZWN0W2NvbHVtbl1bY2hpbGRdKTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXN1bHRzID0+XG4gICAgICAgIHJlc3VsdHMubWFwKG9iamVjdCA9PlxuICAgICAgICAgIHRoaXMucG9zdGdyZXNPYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpXG4gICAgICAgIClcbiAgICAgICk7XG4gIH1cblxuICBhZ2dyZWdhdGUoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogYW55LCBwaXBlbGluZTogYW55KSB7XG4gICAgZGVidWcoJ2FnZ3JlZ2F0ZScsIGNsYXNzTmFtZSwgcGlwZWxpbmUpO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGxldCBpbmRleDogbnVtYmVyID0gMjtcbiAgICBsZXQgY29sdW1uczogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgY291bnRGaWVsZCA9IG51bGw7XG4gICAgbGV0IGdyb3VwVmFsdWVzID0gbnVsbDtcbiAgICBsZXQgd2hlcmVQYXR0ZXJuID0gJyc7XG4gICAgbGV0IGxpbWl0UGF0dGVybiA9ICcnO1xuICAgIGxldCBza2lwUGF0dGVybiA9ICcnO1xuICAgIGxldCBzb3J0UGF0dGVybiA9ICcnO1xuICAgIGxldCBncm91cFBhdHRlcm4gPSAnJztcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHBpcGVsaW5lLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICBjb25zdCBzdGFnZSA9IHBpcGVsaW5lW2ldO1xuICAgICAgaWYgKHN0YWdlLiRncm91cCkge1xuICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHN0YWdlLiRncm91cCkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gc3RhZ2UuJGdyb3VwW2ZpZWxkXTtcbiAgICAgICAgICBpZiAodmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmaWVsZCA9PT0gJ19pZCcgJiYgdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJyAmJiB2YWx1ZSAhPT0gJycpIHtcbiAgICAgICAgICAgIGNvbHVtbnMucHVzaChgJCR7aW5kZXh9Om5hbWUgQVMgXCJvYmplY3RJZFwiYCk7XG4gICAgICAgICAgICBncm91cFBhdHRlcm4gPSBgR1JPVVAgQlkgJCR7aW5kZXh9Om5hbWVgO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUpKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgZmllbGQgPT09ICdfaWQnICYmXG4gICAgICAgICAgICB0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmXG4gICAgICAgICAgICBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoICE9PSAwXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBncm91cFZhbHVlcyA9IHZhbHVlO1xuICAgICAgICAgICAgY29uc3QgZ3JvdXBCeUZpZWxkcyA9IFtdO1xuICAgICAgICAgICAgZm9yIChjb25zdCBhbGlhcyBpbiB2YWx1ZSkge1xuICAgICAgICAgICAgICBjb25zdCBvcGVyYXRpb24gPSBPYmplY3Qua2V5cyh2YWx1ZVthbGlhc10pWzBdO1xuICAgICAgICAgICAgICBjb25zdCBzb3VyY2UgPSB0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZVthbGlhc11bb3BlcmF0aW9uXSk7XG4gICAgICAgICAgICAgIGlmIChtb25nb0FnZ3JlZ2F0ZVRvUG9zdGdyZXNbb3BlcmF0aW9uXSkge1xuICAgICAgICAgICAgICAgIGlmICghZ3JvdXBCeUZpZWxkcy5pbmNsdWRlcyhgXCIke3NvdXJjZX1cImApKSB7XG4gICAgICAgICAgICAgICAgICBncm91cEJ5RmllbGRzLnB1c2goYFwiJHtzb3VyY2V9XCJgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29sdW1ucy5wdXNoKFxuICAgICAgICAgICAgICAgICAgYEVYVFJBQ1QoJHtcbiAgICAgICAgICAgICAgICAgICAgbW9uZ29BZ2dyZWdhdGVUb1Bvc3RncmVzW29wZXJhdGlvbl1cbiAgICAgICAgICAgICAgICAgIH0gRlJPTSAkJHtpbmRleH06bmFtZSBBVCBUSU1FIFpPTkUgJ1VUQycpIEFTICQke2luZGV4ICtcbiAgICAgICAgICAgICAgICAgICAgMX06bmFtZWBcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIHZhbHVlcy5wdXNoKHNvdXJjZSwgYWxpYXMpO1xuICAgICAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGdyb3VwUGF0dGVybiA9IGBHUk9VUCBCWSAkJHtpbmRleH06cmF3YDtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGdyb3VwQnlGaWVsZHMuam9pbigpKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHZhbHVlLiRzdW0pIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgdmFsdWUuJHN1bSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgY29sdW1ucy5wdXNoKGBTVU0oJCR7aW5kZXh9Om5hbWUpIEFTICQke2luZGV4ICsgMX06bmFtZWApO1xuICAgICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZS4kc3VtKSwgZmllbGQpO1xuICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY291bnRGaWVsZCA9IGZpZWxkO1xuICAgICAgICAgICAgICBjb2x1bW5zLnB1c2goYENPVU5UKCopIEFTICQke2luZGV4fTpuYW1lYCk7XG4gICAgICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkKTtcbiAgICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHZhbHVlLiRtYXgpIHtcbiAgICAgICAgICAgIGNvbHVtbnMucHVzaChgTUFYKCQke2luZGV4fTpuYW1lKSBBUyAkJHtpbmRleCArIDF9Om5hbWVgKTtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKHRyYW5zZm9ybUFnZ3JlZ2F0ZUZpZWxkKHZhbHVlLiRtYXgpLCBmaWVsZCk7XG4gICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodmFsdWUuJG1pbikge1xuICAgICAgICAgICAgY29sdW1ucy5wdXNoKGBNSU4oJCR7aW5kZXh9Om5hbWUpIEFTICQke2luZGV4ICsgMX06bmFtZWApO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUuJG1pbiksIGZpZWxkKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh2YWx1ZS4kYXZnKSB7XG4gICAgICAgICAgICBjb2x1bW5zLnB1c2goYEFWRygkJHtpbmRleH06bmFtZSkgQVMgJCR7aW5kZXggKyAxfTpuYW1lYCk7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZS4kYXZnKSwgZmllbGQpO1xuICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbHVtbnMucHVzaCgnKicpO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRwcm9qZWN0KSB7XG4gICAgICAgIGlmIChjb2x1bW5zLmluY2x1ZGVzKCcqJykpIHtcbiAgICAgICAgICBjb2x1bW5zID0gW107XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBzdGFnZS4kcHJvamVjdCkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gc3RhZ2UuJHByb2plY3RbZmllbGRdO1xuICAgICAgICAgIGlmICh2YWx1ZSA9PT0gMSB8fCB2YWx1ZSA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgY29sdW1ucy5wdXNoKGAkJHtpbmRleH06bmFtZWApO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2goZmllbGQpO1xuICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kbWF0Y2gpIHtcbiAgICAgICAgY29uc3QgcGF0dGVybnMgPSBbXTtcbiAgICAgICAgY29uc3Qgb3JPckFuZCA9IHN0YWdlLiRtYXRjaC5oYXNPd25Qcm9wZXJ0eSgnJG9yJykgPyAnIE9SICcgOiAnIEFORCAnO1xuXG4gICAgICAgIGlmIChzdGFnZS4kbWF0Y2guJG9yKSB7XG4gICAgICAgICAgY29uc3QgY29sbGFwc2UgPSB7fTtcbiAgICAgICAgICBzdGFnZS4kbWF0Y2guJG9yLmZvckVhY2goZWxlbWVudCA9PiB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBpbiBlbGVtZW50KSB7XG4gICAgICAgICAgICAgIGNvbGxhcHNlW2tleV0gPSBlbGVtZW50W2tleV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgc3RhZ2UuJG1hdGNoID0gY29sbGFwc2U7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBzdGFnZS4kbWF0Y2gpIHtcbiAgICAgICAgICBjb25zdCB2YWx1ZSA9IHN0YWdlLiRtYXRjaFtmaWVsZF07XG4gICAgICAgICAgY29uc3QgbWF0Y2hQYXR0ZXJucyA9IFtdO1xuICAgICAgICAgIE9iamVjdC5rZXlzKFBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvcikuZm9yRWFjaChjbXAgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbHVlW2NtcF0pIHtcbiAgICAgICAgICAgICAgY29uc3QgcGdDb21wYXJhdG9yID0gUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yW2NtcF07XG4gICAgICAgICAgICAgIG1hdGNoUGF0dGVybnMucHVzaChcbiAgICAgICAgICAgICAgICBgJCR7aW5kZXh9Om5hbWUgJHtwZ0NvbXBhcmF0b3J9ICQke2luZGV4ICsgMX1gXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkLCB0b1Bvc3RncmVzVmFsdWUodmFsdWVbY21wXSkpO1xuICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChtYXRjaFBhdHRlcm5zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCgke21hdGNoUGF0dGVybnMuam9pbignIEFORCAnKX0pYCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGRdICYmXG4gICAgICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlICYmXG4gICAgICAgICAgICBtYXRjaFBhdHRlcm5zLmxlbmd0aCA9PT0gMFxuICAgICAgICAgICkge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZCwgdmFsdWUpO1xuICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgd2hlcmVQYXR0ZXJuID1cbiAgICAgICAgICBwYXR0ZXJucy5sZW5ndGggPiAwID8gYFdIRVJFICR7cGF0dGVybnMuam9pbihgICR7b3JPckFuZH0gYCl9YCA6ICcnO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRsaW1pdCkge1xuICAgICAgICBsaW1pdFBhdHRlcm4gPSBgTElNSVQgJCR7aW5kZXh9YDtcbiAgICAgICAgdmFsdWVzLnB1c2goc3RhZ2UuJGxpbWl0KTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kc2tpcCkge1xuICAgICAgICBza2lwUGF0dGVybiA9IGBPRkZTRVQgJCR7aW5kZXh9YDtcbiAgICAgICAgdmFsdWVzLnB1c2goc3RhZ2UuJHNraXApO1xuICAgICAgICBpbmRleCArPSAxO1xuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRzb3J0KSB7XG4gICAgICAgIGNvbnN0IHNvcnQgPSBzdGFnZS4kc29ydDtcbiAgICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHNvcnQpO1xuICAgICAgICBjb25zdCBzb3J0aW5nID0ga2V5c1xuICAgICAgICAgIC5tYXAoa2V5ID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHRyYW5zZm9ybWVyID0gc29ydFtrZXldID09PSAxID8gJ0FTQycgOiAnREVTQyc7XG4gICAgICAgICAgICBjb25zdCBvcmRlciA9IGAkJHtpbmRleH06bmFtZSAke3RyYW5zZm9ybWVyfWA7XG4gICAgICAgICAgICBpbmRleCArPSAxO1xuICAgICAgICAgICAgcmV0dXJuIG9yZGVyO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmpvaW4oKTtcbiAgICAgICAgdmFsdWVzLnB1c2goLi4ua2V5cyk7XG4gICAgICAgIHNvcnRQYXR0ZXJuID1cbiAgICAgICAgICBzb3J0ICE9PSB1bmRlZmluZWQgJiYgc29ydGluZy5sZW5ndGggPiAwID8gYE9SREVSIEJZICR7c29ydGluZ31gIDogJyc7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcXMgPSBgU0VMRUNUICR7Y29sdW1ucy5qb2luKCl9IEZST00gJDE6bmFtZSAke3doZXJlUGF0dGVybn0gJHtzb3J0UGF0dGVybn0gJHtsaW1pdFBhdHRlcm59ICR7c2tpcFBhdHRlcm59ICR7Z3JvdXBQYXR0ZXJufWA7XG4gICAgZGVidWcocXMsIHZhbHVlcyk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLm1hcChxcywgdmFsdWVzLCBhID0+XG4gICAgICAgIHRoaXMucG9zdGdyZXNPYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgYSwgc2NoZW1hKVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICAgIGlmICghcmVzdWx0Lmhhc093blByb3BlcnR5KCdvYmplY3RJZCcpKSB7XG4gICAgICAgICAgICByZXN1bHQub2JqZWN0SWQgPSBudWxsO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZ3JvdXBWYWx1ZXMpIHtcbiAgICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IHt9O1xuICAgICAgICAgICAgZm9yIChjb25zdCBrZXkgaW4gZ3JvdXBWYWx1ZXMpIHtcbiAgICAgICAgICAgICAgcmVzdWx0Lm9iamVjdElkW2tleV0gPSByZXN1bHRba2V5XTtcbiAgICAgICAgICAgICAgZGVsZXRlIHJlc3VsdFtrZXldO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY291bnRGaWVsZCkge1xuICAgICAgICAgICAgcmVzdWx0W2NvdW50RmllbGRdID0gcGFyc2VJbnQocmVzdWx0W2NvdW50RmllbGRdLCAxMCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICB9KTtcbiAgfVxuXG4gIHBlcmZvcm1Jbml0aWFsaXphdGlvbih7IFZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMgfTogYW55KSB7XG4gICAgLy8gVE9ETzogVGhpcyBtZXRob2QgbmVlZHMgdG8gYmUgcmV3cml0dGVuIHRvIG1ha2UgcHJvcGVyIHVzZSBvZiBjb25uZWN0aW9ucyAoQHZpdGFseS10KVxuICAgIGRlYnVnKCdwZXJmb3JtSW5pdGlhbGl6YXRpb24nKTtcbiAgICBjb25zdCBwcm9taXNlcyA9IFZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMubWFwKHNjaGVtYSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVUYWJsZShzY2hlbWEuY2xhc3NOYW1lLCBzY2hlbWEpXG4gICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIGVyci5jb2RlID09PSBQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IgfHxcbiAgICAgICAgICAgIGVyci5jb2RlID09PSBQYXJzZS5FcnJvci5JTlZBTElEX0NMQVNTX05BTUVcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbigoKSA9PiB0aGlzLnNjaGVtYVVwZ3JhZGUoc2NoZW1hLmNsYXNzTmFtZSwgc2NoZW1hKSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdGhpcy5fY2xpZW50LnR4KCdwZXJmb3JtLWluaXRpYWxpemF0aW9uJywgdCA9PiB7XG4gICAgICAgICAgcmV0dXJuIHQuYmF0Y2goW1xuICAgICAgICAgICAgdC5ub25lKHNxbC5taXNjLmpzb25PYmplY3RTZXRLZXlzKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuYWRkKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuYWRkVW5pcXVlKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkucmVtb3ZlKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuY29udGFpbnNBbGwpLFxuICAgICAgICAgICAgdC5ub25lKHNxbC5hcnJheS5jb250YWluc0FsbFJlZ2V4KSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuY29udGFpbnMpLFxuICAgICAgICAgIF0pO1xuICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihkYXRhID0+IHtcbiAgICAgICAgZGVidWcoYGluaXRpYWxpemF0aW9uRG9uZSBpbiAke2RhdGEuZHVyYXRpb259YCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgLyogZXNsaW50LWRpc2FibGUgbm8tY29uc29sZSAqL1xuICAgICAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgY3JlYXRlSW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZywgaW5kZXhlczogYW55LCBjb25uOiA/YW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIChjb25uIHx8IHRoaXMuX2NsaWVudCkudHgodCA9PlxuICAgICAgdC5iYXRjaChcbiAgICAgICAgaW5kZXhlcy5tYXAoaSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHQubm9uZSgnQ1JFQVRFIElOREVYICQxOm5hbWUgT04gJDI6bmFtZSAoJDM6bmFtZSknLCBbXG4gICAgICAgICAgICBpLm5hbWUsXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICBpLmtleSxcbiAgICAgICAgICBdKTtcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICApO1xuICB9XG5cbiAgY3JlYXRlSW5kZXhlc0lmTmVlZGVkKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIGZpZWxkTmFtZTogc3RyaW5nLFxuICAgIHR5cGU6IGFueSxcbiAgICBjb25uOiA/YW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiAoY29ubiB8fCB0aGlzLl9jbGllbnQpLm5vbmUoXG4gICAgICAnQ1JFQVRFIElOREVYICQxOm5hbWUgT04gJDI6bmFtZSAoJDM6bmFtZSknLFxuICAgICAgW2ZpZWxkTmFtZSwgY2xhc3NOYW1lLCB0eXBlXVxuICAgICk7XG4gIH1cblxuICBkcm9wSW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZywgaW5kZXhlczogYW55LCBjb25uOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBxdWVyaWVzID0gaW5kZXhlcy5tYXAoaSA9PiAoe1xuICAgICAgcXVlcnk6ICdEUk9QIElOREVYICQxOm5hbWUnLFxuICAgICAgdmFsdWVzOiBpLFxuICAgIH0pKTtcbiAgICByZXR1cm4gKGNvbm4gfHwgdGhpcy5fY2xpZW50KS50eCh0ID0+XG4gICAgICB0Lm5vbmUodGhpcy5fcGdwLmhlbHBlcnMuY29uY2F0KHF1ZXJpZXMpKVxuICAgICk7XG4gIH1cblxuICBnZXRJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3QgcXMgPSAnU0VMRUNUICogRlJPTSBwZ19pbmRleGVzIFdIRVJFIHRhYmxlbmFtZSA9ICR7Y2xhc3NOYW1lfSc7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC5hbnkocXMsIHsgY2xhc3NOYW1lIH0pO1xuICB9XG5cbiAgdXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRQb2x5Z29uVG9TUUwocG9seWdvbikge1xuICBpZiAocG9seWdvbi5sZW5ndGggPCAzKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgYFBvbHlnb24gbXVzdCBoYXZlIGF0IGxlYXN0IDMgdmFsdWVzYFxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIHBvbHlnb25bMF1bMF0gIT09IHBvbHlnb25bcG9seWdvbi5sZW5ndGggLSAxXVswXSB8fFxuICAgIHBvbHlnb25bMF1bMV0gIT09IHBvbHlnb25bcG9seWdvbi5sZW5ndGggLSAxXVsxXVxuICApIHtcbiAgICBwb2x5Z29uLnB1c2gocG9seWdvblswXSk7XG4gIH1cbiAgY29uc3QgdW5pcXVlID0gcG9seWdvbi5maWx0ZXIoKGl0ZW0sIGluZGV4LCBhcikgPT4ge1xuICAgIGxldCBmb3VuZEluZGV4ID0gLTE7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhci5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgY29uc3QgcHQgPSBhcltpXTtcbiAgICAgIGlmIChwdFswXSA9PT0gaXRlbVswXSAmJiBwdFsxXSA9PT0gaXRlbVsxXSkge1xuICAgICAgICBmb3VuZEluZGV4ID0gaTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmb3VuZEluZGV4ID09PSBpbmRleDtcbiAgfSk7XG4gIGlmICh1bmlxdWUubGVuZ3RoIDwgMykge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVEVSTkFMX1NFUlZFUl9FUlJPUixcbiAgICAgICdHZW9KU09OOiBMb29wIG11c3QgaGF2ZSBhdCBsZWFzdCAzIGRpZmZlcmVudCB2ZXJ0aWNlcydcbiAgICApO1xuICB9XG4gIGNvbnN0IHBvaW50cyA9IHBvbHlnb25cbiAgICAubWFwKHBvaW50ID0+IHtcbiAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwYXJzZUZsb2F0KHBvaW50WzFdKSwgcGFyc2VGbG9hdChwb2ludFswXSkpO1xuICAgICAgcmV0dXJuIGAoJHtwb2ludFsxXX0sICR7cG9pbnRbMF19KWA7XG4gICAgfSlcbiAgICAuam9pbignLCAnKTtcbiAgcmV0dXJuIGAoJHtwb2ludHN9KWA7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVdoaXRlU3BhY2UocmVnZXgpIHtcbiAgaWYgKCFyZWdleC5lbmRzV2l0aCgnXFxuJykpIHtcbiAgICByZWdleCArPSAnXFxuJztcbiAgfVxuXG4gIC8vIHJlbW92ZSBub24gZXNjYXBlZCBjb21tZW50c1xuICByZXR1cm4gKFxuICAgIHJlZ2V4XG4gICAgICAucmVwbGFjZSgvKFteXFxcXF0pIy4qXFxuL2dpbSwgJyQxJylcbiAgICAgIC8vIHJlbW92ZSBsaW5lcyBzdGFydGluZyB3aXRoIGEgY29tbWVudFxuICAgICAgLnJlcGxhY2UoL14jLipcXG4vZ2ltLCAnJylcbiAgICAgIC8vIHJlbW92ZSBub24gZXNjYXBlZCB3aGl0ZXNwYWNlXG4gICAgICAucmVwbGFjZSgvKFteXFxcXF0pXFxzKy9naW0sICckMScpXG4gICAgICAvLyByZW1vdmUgd2hpdGVzcGFjZSBhdCB0aGUgYmVnaW5uaW5nIG9mIGEgbGluZVxuICAgICAgLnJlcGxhY2UoL15cXHMrLywgJycpXG4gICAgICAudHJpbSgpXG4gICk7XG59XG5cbmZ1bmN0aW9uIHByb2Nlc3NSZWdleFBhdHRlcm4ocykge1xuICBpZiAocyAmJiBzLnN0YXJ0c1dpdGgoJ14nKSkge1xuICAgIC8vIHJlZ2V4IGZvciBzdGFydHNXaXRoXG4gICAgcmV0dXJuICdeJyArIGxpdGVyYWxpemVSZWdleFBhcnQocy5zbGljZSgxKSk7XG4gIH0gZWxzZSBpZiAocyAmJiBzLmVuZHNXaXRoKCckJykpIHtcbiAgICAvLyByZWdleCBmb3IgZW5kc1dpdGhcbiAgICByZXR1cm4gbGl0ZXJhbGl6ZVJlZ2V4UGFydChzLnNsaWNlKDAsIHMubGVuZ3RoIC0gMSkpICsgJyQnO1xuICB9XG4gIC8vIHJlZ2V4IGZvciBjb250YWluc1xuICByZXR1cm4gbGl0ZXJhbGl6ZVJlZ2V4UGFydChzKTtcbn1cblxuZnVuY3Rpb24gaXNTdGFydHNXaXRoUmVnZXgodmFsdWUpIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8ICF2YWx1ZS5zdGFydHNXaXRoKCdeJykpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjb25zdCBtYXRjaGVzID0gdmFsdWUubWF0Y2goL1xcXlxcXFxRLipcXFxcRS8pO1xuICByZXR1cm4gISFtYXRjaGVzO1xufVxuXG5mdW5jdGlvbiBpc0FsbFZhbHVlc1JlZ2V4T3JOb25lKHZhbHVlcykge1xuICBpZiAoIXZhbHVlcyB8fCAhQXJyYXkuaXNBcnJheSh2YWx1ZXMpIHx8IHZhbHVlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGNvbnN0IGZpcnN0VmFsdWVzSXNSZWdleCA9IGlzU3RhcnRzV2l0aFJlZ2V4KHZhbHVlc1swXS4kcmVnZXgpO1xuICBpZiAodmFsdWVzLmxlbmd0aCA9PT0gMSkge1xuICAgIHJldHVybiBmaXJzdFZhbHVlc0lzUmVnZXg7XG4gIH1cblxuICBmb3IgKGxldCBpID0gMSwgbGVuZ3RoID0gdmFsdWVzLmxlbmd0aDsgaSA8IGxlbmd0aDsgKytpKSB7XG4gICAgaWYgKGZpcnN0VmFsdWVzSXNSZWdleCAhPT0gaXNTdGFydHNXaXRoUmVnZXgodmFsdWVzW2ldLiRyZWdleCkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gaXNBbnlWYWx1ZVJlZ2V4U3RhcnRzV2l0aCh2YWx1ZXMpIHtcbiAgcmV0dXJuIHZhbHVlcy5zb21lKGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgcmV0dXJuIGlzU3RhcnRzV2l0aFJlZ2V4KHZhbHVlLiRyZWdleCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVMaXRlcmFsUmVnZXgocmVtYWluaW5nKSB7XG4gIHJldHVybiByZW1haW5pbmdcbiAgICAuc3BsaXQoJycpXG4gICAgLm1hcChjID0+IHtcbiAgICAgIGNvbnN0IHJlZ2V4ID0gWFJlZ0V4cCgnWzAtOSBdfFxcXFxwe0x9Jyk7XG4gICAgICBpZiAoYy5tYXRjaChyZWdleCkgIT09IG51bGwpIHtcbiAgICAgICAgLy8gZG9uJ3QgZXNjYXBlIGFscGhhbnVtZXJpYyBjaGFyYWN0ZXJzXG4gICAgICAgIHJldHVybiBjO1xuICAgICAgfVxuICAgICAgLy8gZXNjYXBlIGV2ZXJ5dGhpbmcgZWxzZSAoc2luZ2xlIHF1b3RlcyB3aXRoIHNpbmdsZSBxdW90ZXMsIGV2ZXJ5dGhpbmcgZWxzZSB3aXRoIGEgYmFja3NsYXNoKVxuICAgICAgcmV0dXJuIGMgPT09IGAnYCA/IGAnJ2AgOiBgXFxcXCR7Y31gO1xuICAgIH0pXG4gICAgLmpvaW4oJycpO1xufVxuXG5mdW5jdGlvbiBsaXRlcmFsaXplUmVnZXhQYXJ0KHM6IHN0cmluZykge1xuXG4gIGNvbnN0IG1hdGNoZXIxID0gL1xcXFxRKCg/IVxcXFxFKS4qKVxcXFxFJC87XG4gIGNvbnN0IHJlc3VsdDE6IGFueSA9IHMubWF0Y2gobWF0Y2hlcjEpO1xuICBpZiAocmVzdWx0MSAmJiByZXN1bHQxLmxlbmd0aCA+IDEgJiYgcmVzdWx0MS5pbmRleCA+IC0xKSB7XG4gICAgLy8gcHJvY2VzcyByZWdleCB0aGF0IGhhcyBhIGJlZ2lubmluZyBhbmQgYW4gZW5kIHNwZWNpZmllZCBmb3IgdGhlIGxpdGVyYWwgdGV4dFxuICAgIGNvbnN0IHByZWZpeCA9IHMuc3Vic3RyKDAsIHJlc3VsdDEuaW5kZXgpO1xuICAgIGNvbnN0IHJlbWFpbmluZyA9IHJlc3VsdDFbMV07XG4gICAgcmV0dXJuIGxpdGVyYWxpemVSZWdleFBhcnQocHJlZml4KSArIGNyZWF0ZUxpdGVyYWxSZWdleChyZW1haW5pbmcpO1xuICB9XG5cbiAgLy8gcHJvY2VzcyByZWdleCB0aGF0IGhhcyBhIGJlZ2lubmluZyBzcGVjaWZpZWQgZm9yIHRoZSBsaXRlcmFsIHRleHRcbiAgY29uc3QgbWF0Y2hlcjIgPSAvXFxcXFEoKD8hXFxcXEUpLiopJC87XG4gIGNvbnN0IHJlc3VsdDI6IGFueSA9IHMubWF0Y2gobWF0Y2hlcjIpO1xuICBpZiAocmVzdWx0MiAmJiByZXN1bHQyLmxlbmd0aCA+IDEgJiYgcmVzdWx0Mi5pbmRleCA+IC0xKSB7XG4gICAgY29uc3QgcHJlZml4ID0gcy5zdWJzdHIoMCwgcmVzdWx0Mi5pbmRleCk7XG4gICAgY29uc3QgcmVtYWluaW5nID0gcmVzdWx0MlsxXTtcbiAgICByZXR1cm4gbGl0ZXJhbGl6ZVJlZ2V4UGFydChwcmVmaXgpICsgY3JlYXRlTGl0ZXJhbFJlZ2V4KHJlbWFpbmluZyk7XG4gIH1cblxuICAvLyByZW1vdmUgYWxsIGluc3RhbmNlcyBvZiBcXFEgYW5kIFxcRSBmcm9tIHRoZSByZW1haW5pbmcgdGV4dCAmIGVzY2FwZSBzaW5nbGUgcXVvdGVzXG5cblxuICBjb25zdCB2YWx1ZSA9IHNcbiAgLnJlcGxhY2UoLyhbXlxcXFxdKShcXFxcRSkvLCAnJDEnKVxuICAucmVwbGFjZSgvKFteXFxcXF0pKFxcXFxRKS8sICckMScpXG4gIC5yZXBsYWNlKC9eXFxcXEUvLCAnJylcbiAgLnJlcGxhY2UoL15cXFxcUS8sICcnKVxuICAucmVwbGFjZSgvKFteJ10pJy8sIGAkMScnYClcbiAgLnJlcGxhY2UoL14nKFteJ10pLywgYCcnJDFgKTtcbiAgcmV0dXJuIHZhbHVlO1xufVxuXG52YXIgR2VvUG9pbnRDb2RlciA9IHtcbiAgaXNWYWxpZEpTT04odmFsdWUpIHtcbiAgICByZXR1cm4gKFxuICAgICAgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZS5fX3R5cGUgPT09ICdHZW9Qb2ludCdcbiAgICApO1xuICB9LFxufTtcblxuZXhwb3J0IGRlZmF1bHQgUG9zdGdyZXNTdG9yYWdlQWRhcHRlcjtcbiJdfQ==