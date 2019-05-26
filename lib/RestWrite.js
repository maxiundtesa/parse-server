"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _RestQuery = _interopRequireDefault(require("./RestQuery"));

var _lodash = _interopRequireDefault(require("lodash"));

var _logger = _interopRequireDefault(require("./logger"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// A RestWrite encapsulates everything we need to run an operation
// that writes to the database.
// This could be either a "create" or an "update".
var SchemaController = require('./Controllers/SchemaController');

var deepcopy = require('deepcopy');

const Auth = require('./Auth');

var cryptoUtils = require('./cryptoUtils');

var passwordCrypto = require('./password');

var Parse = require('parse/node');

var triggers = require('./triggers');

var ClientSDK = require('./ClientSDK');

// query and data are both provided in REST API format. So data
// types are encoded by plain old objects.
// If query is null, this is a "create" and the data in data should be
// created.
// Otherwise this is an "update" - the object matching the query
// should get updated with data.
// RestWrite will handle objectId, createdAt, and updatedAt for
// everything. It also knows to use triggers and special modifications
// for the _User class.
function RestWrite(config, auth, className, query, data, originalData, clientSDK) {
  if (auth.isReadOnly) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Cannot perform a write operation when using readOnlyMasterKey');
  }

  this.config = config;
  this.auth = auth;
  this.className = className;
  this.clientSDK = clientSDK;
  this.storage = {};
  this.runOptions = {};
  this.context = {};

  if (!query && data.objectId) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'objectId is an invalid field name.');
  } // When the operation is complete, this.response may have several
  // fields.
  // response: the actual data to be returned
  // status: the http status code. if not present, treated like a 200
  // location: the location header. if not present, no location header


  this.response = null; // Processing this operation may mutate our data, so we operate on a
  // copy

  this.query = deepcopy(query);
  this.data = deepcopy(data); // We never change originalData, so we do not need a deep copy

  this.originalData = originalData; // The timestamp we'll use for this whole operation

  this.updatedAt = Parse._encode(new Date()).iso;
} // A convenient method to perform all the steps of processing the
// write, in order.
// Returns a promise for a {response, status, location} object.
// status and location are optional.


RestWrite.prototype.execute = function () {
  return Promise.resolve().then(() => {
    return this.getUserAndRoleACL();
  }).then(() => {
    return this.validateClientClassCreation();
  }).then(() => {
    return this.handleInstallation();
  }).then(() => {
    return this.handleSession();
  }).then(() => {
    return this.validateAuthData();
  }).then(() => {
    return this.runBeforeSaveTrigger();
  }).then(() => {
    return this.deleteEmailResetTokenIfNeeded();
  }).then(() => {
    return this.validateSchema();
  }).then(() => {
    return this.setRequiredFieldsIfNeeded();
  }).then(() => {
    return this.transformUser();
  }).then(() => {
    return this.expandFilesForExistingObjects();
  }).then(() => {
    return this.destroyDuplicatedSessions();
  }).then(() => {
    return this.runDatabaseOperation();
  }).then(() => {
    return this.createSessionTokenIfNeeded();
  }).then(() => {
    return this.handleFollowup();
  }).then(() => {
    return this.runAfterSaveTrigger();
  }).then(() => {
    return this.cleanUserAuthData();
  }).then(() => {
    return this.response;
  });
}; // Uses the Auth object to get the list of roles, adds the user id


RestWrite.prototype.getUserAndRoleACL = function () {
  if (this.auth.isMaster) {
    return Promise.resolve();
  }

  this.runOptions.acl = ['*'];

  if (this.auth.user) {
    return this.auth.getUserRoles().then(roles => {
      this.runOptions.acl = this.runOptions.acl.concat(roles, [this.auth.user.id]);
      return;
    });
  } else {
    return Promise.resolve();
  }
}; // Validates this operation against the allowClientClassCreation config.


RestWrite.prototype.validateClientClassCreation = function () {
  if (this.config.allowClientClassCreation === false && !this.auth.isMaster && SchemaController.systemClasses.indexOf(this.className) === -1) {
    return this.config.database.loadSchema().then(schemaController => schemaController.hasClass(this.className)).then(hasClass => {
      if (hasClass !== true) {
        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This user is not allowed to access ' + 'non-existent class: ' + this.className);
      }
    });
  } else {
    return Promise.resolve();
  }
}; // Validates this operation against the schema.


RestWrite.prototype.validateSchema = function () {
  return this.config.database.validateObject(this.className, this.data, this.query, this.runOptions);
}; // Runs any beforeSave triggers against this operation.
// Any change leads to our data being mutated.


RestWrite.prototype.runBeforeSaveTrigger = function () {
  if (this.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'beforeSave' trigger for this class.


  if (!triggers.triggerExists(this.className, triggers.Types.beforeSave, this.config.applicationId)) {
    return Promise.resolve();
  } // Cloud code gets a bit of extra data for its objects


  var extraData = {
    className: this.className
  };

  if (this.query && this.query.objectId) {
    extraData.objectId = this.query.objectId;
  }

  let originalObject = null;
  const updatedObject = this.buildUpdatedObject(extraData);

  if (this.query && this.query.objectId) {
    // This is an update for existing object.
    originalObject = triggers.inflate(extraData, this.originalData);
  }

  return Promise.resolve().then(() => {
    // Before calling the trigger, validate the permissions for the save operation
    let databasePromise = null;

    if (this.query) {
      // Validate for updating
      databasePromise = this.config.database.update(this.className, this.query, this.data, this.runOptions, false, true);
    } else {
      // Validate for creating
      databasePromise = this.config.database.create(this.className, this.data, this.runOptions, true);
    } // In the case that there is no permission for the operation, it throws an error


    return databasePromise.then(result => {
      if (!result || result.length <= 0) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
      }
    });
  }).then(() => {
    return triggers.maybeRunTrigger(triggers.Types.beforeSave, this.auth, updatedObject, originalObject, this.config, this.context);
  }).then(response => {
    if (response && response.object) {
      this.storage.fieldsChangedByTrigger = _lodash.default.reduce(response.object, (result, value, key) => {
        if (!_lodash.default.isEqual(this.data[key], value)) {
          result.push(key);
        }

        return result;
      }, []);
      this.data = response.object; // We should delete the objectId for an update write

      if (this.query && this.query.objectId) {
        delete this.data.objectId;
      }
    }
  });
};

RestWrite.prototype.runBeforeLoginTrigger = async function (userData) {
  // Avoid doing any setup for triggers if there is no 'beforeLogin' trigger
  if (!triggers.triggerExists(this.className, triggers.Types.beforeLogin, this.config.applicationId)) {
    return;
  } // Cloud code gets a bit of extra data for its objects


  const extraData = {
    className: this.className
  };
  const user = triggers.inflate(extraData, userData); // no need to return a response

  await triggers.maybeRunTrigger(triggers.Types.beforeLogin, this.auth, user, null, this.config, this.context);
};

RestWrite.prototype.setRequiredFieldsIfNeeded = function () {
  if (this.data) {
    // Add default fields
    this.data.updatedAt = this.updatedAt;

    if (!this.query) {
      this.data.createdAt = this.updatedAt; // Only assign new objectId if we are creating new object

      if (!this.data.objectId) {
        this.data.objectId = cryptoUtils.newObjectId(this.config.objectIdSize);
      }
    }
  }

  return Promise.resolve();
}; // Transforms auth data for a user object.
// Does nothing if this isn't a user object.
// Returns a promise for when we're done if it can't finish this tick.


RestWrite.prototype.validateAuthData = function () {
  if (this.className !== '_User') {
    return;
  }

  if (!this.query && !this.data.authData) {
    if (typeof this.data.username !== 'string' || _lodash.default.isEmpty(this.data.username)) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'bad or missing username');
    }

    if (typeof this.data.password !== 'string' || _lodash.default.isEmpty(this.data.password)) {
      throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'password is required');
    }
  }

  if (!this.data.authData || !Object.keys(this.data.authData).length) {
    return;
  }

  var authData = this.data.authData;
  var providers = Object.keys(authData);

  if (providers.length > 0) {
    const canHandleAuthData = providers.reduce((canHandle, provider) => {
      var providerAuthData = authData[provider];
      var hasToken = providerAuthData && providerAuthData.id;
      return canHandle && (hasToken || providerAuthData == null);
    }, true);

    if (canHandleAuthData) {
      return this.handleAuthData(authData);
    }
  }

  throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
};

RestWrite.prototype.handleAuthDataValidation = function (authData) {
  const validations = Object.keys(authData).map(provider => {
    if (authData[provider] === null) {
      return Promise.resolve();
    }

    const validateAuthData = this.config.authDataManager.getValidatorForProvider(provider);

    if (!validateAuthData) {
      throw new Parse.Error(Parse.Error.UNSUPPORTED_SERVICE, 'This authentication method is unsupported.');
    }

    return validateAuthData(authData[provider]);
  });
  return Promise.all(validations);
};

RestWrite.prototype.findUsersWithAuthData = function (authData) {
  const providers = Object.keys(authData);
  const query = providers.reduce((memo, provider) => {
    if (!authData[provider]) {
      return memo;
    }

    const queryKey = `authData.${provider}.id`;
    const query = {};
    query[queryKey] = authData[provider].id;
    memo.push(query);
    return memo;
  }, []).filter(q => {
    return typeof q !== 'undefined';
  });
  let findPromise = Promise.resolve([]);

  if (query.length > 0) {
    findPromise = this.config.database.find(this.className, {
      $or: query
    }, {});
  }

  return findPromise;
};

RestWrite.prototype.filteredObjectsByACL = function (objects) {
  if (this.auth.isMaster) {
    return objects;
  }

  return objects.filter(object => {
    if (!object.ACL) {
      return true; // legacy users that have no ACL field on them
    } // Regular users that have been locked out.


    return object.ACL && Object.keys(object.ACL).length > 0;
  });
};

RestWrite.prototype.handleAuthData = function (authData) {
  let results;
  return this.findUsersWithAuthData(authData).then(async r => {
    results = this.filteredObjectsByACL(r);

    if (results.length > 1) {
      // More than 1 user with the passed id's
      throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
    }

    this.storage['authProvider'] = Object.keys(authData).join(',');

    if (results.length > 0) {
      const userResult = results[0];
      const mutatedAuthData = {};
      Object.keys(authData).forEach(provider => {
        const providerData = authData[provider];
        const userAuthData = userResult.authData[provider];

        if (!_lodash.default.isEqual(providerData, userAuthData)) {
          mutatedAuthData[provider] = providerData;
        }
      });
      const hasMutatedAuthData = Object.keys(mutatedAuthData).length !== 0;
      let userId;

      if (this.query && this.query.objectId) {
        userId = this.query.objectId;
      } else if (this.auth && this.auth.user && this.auth.user.id) {
        userId = this.auth.user.id;
      }

      if (!userId || userId === userResult.objectId) {
        // no user making the call
        // OR the user making the call is the right one
        // Login with auth data
        delete results[0].password; // need to set the objectId first otherwise location has trailing undefined

        this.data.objectId = userResult.objectId;

        if (!this.query || !this.query.objectId) {
          // this a login call, no userId passed
          this.response = {
            response: userResult,
            location: this.location()
          }; // Run beforeLogin hook before storing any updates
          // to authData on the db; changes to userResult
          // will be ignored.

          await this.runBeforeLoginTrigger(deepcopy(userResult));
        } // If we didn't change the auth data, just keep going


        if (!hasMutatedAuthData) {
          return;
        } // We have authData that is updated on login
        // that can happen when token are refreshed,
        // We should update the token and let the user in
        // We should only check the mutated keys


        return this.handleAuthDataValidation(mutatedAuthData).then(async () => {
          // IF we have a response, we'll skip the database operation / beforeSave / afterSave etc...
          // we need to set it up there.
          // We are supposed to have a response only on LOGIN with authData, so we skip those
          // If we're not logging in, but just updating the current user, we can safely skip that part
          if (this.response) {
            // Assign the new authData in the response
            Object.keys(mutatedAuthData).forEach(provider => {
              this.response.response.authData[provider] = mutatedAuthData[provider];
            }); // Run the DB update directly, as 'master'
            // Just update the authData part
            // Then we're good for the user, early exit of sorts

            return this.config.database.update(this.className, {
              objectId: this.data.objectId
            }, {
              authData: mutatedAuthData
            }, {});
          }
        });
      } else if (userId) {
        // Trying to update auth data but users
        // are different
        if (userResult.objectId !== userId) {
          throw new Parse.Error(Parse.Error.ACCOUNT_ALREADY_LINKED, 'this auth is already used');
        } // No auth data was mutated, just keep going


        if (!hasMutatedAuthData) {
          return;
        }
      }
    }

    return this.handleAuthDataValidation(authData);
  });
}; // The non-third-party parts of User transformation


RestWrite.prototype.transformUser = function () {
  var promise = Promise.resolve();

  if (this.className !== '_User') {
    return promise;
  }

  if (!this.auth.isMaster && 'emailVerified' in this.data) {
    const error = `Clients aren't allowed to manually update email verification.`;
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, error);
  } // Do not cleanup session if objectId is not set


  if (this.query && this.objectId()) {
    // If we're updating a _User object, we need to clear out the cache for that user. Find all their
    // session tokens, and remove them from the cache.
    promise = new _RestQuery.default(this.config, Auth.master(this.config), '_Session', {
      user: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.objectId()
      }
    }).execute().then(results => {
      results.results.forEach(session => this.config.cacheController.user.del(session.sessionToken));
    });
  }

  return promise.then(() => {
    // Transform the password
    if (this.data.password === undefined) {
      // ignore only if undefined. should proceed if empty ('')
      return Promise.resolve();
    }

    if (this.query) {
      this.storage['clearSessions'] = true; // Generate a new session only if the user requested

      if (!this.auth.isMaster) {
        this.storage['generateNewSession'] = true;
      }
    }

    return this._validatePasswordPolicy().then(() => {
      return passwordCrypto.hash(this.data.password).then(hashedPassword => {
        this.data._hashed_password = hashedPassword;
        delete this.data.password;
      });
    });
  }).then(() => {
    return this._validateUserName();
  }).then(() => {
    return this._validateEmail();
  });
};

RestWrite.prototype._validateUserName = function () {
  // Check for username uniqueness
  if (!this.data.username) {
    if (!this.query) {
      this.data.username = cryptoUtils.randomString(25);
      this.responseShouldHaveUsername = true;
    }

    return Promise.resolve();
  } // We need to a find to check for duplicate username in case they are missing the unique index on usernames
  // TODO: Check if there is a unique index, and if so, skip this query.


  return this.config.database.find(this.className, {
    username: this.data.username,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1
  }).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
    }

    return;
  });
};

RestWrite.prototype._validateEmail = function () {
  if (!this.data.email || this.data.email.__op === 'Delete') {
    return Promise.resolve();
  } // Validate basic email address format


  if (!this.data.email.match(/^.+@.+$/)) {
    return Promise.reject(new Parse.Error(Parse.Error.INVALID_EMAIL_ADDRESS, 'Email address format is invalid.'));
  } // Same problem for email as above for username


  return this.config.database.find(this.className, {
    email: this.data.email,
    objectId: {
      $ne: this.objectId()
    }
  }, {
    limit: 1
  }).then(results => {
    if (results.length > 0) {
      throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
    }

    if (!this.data.authData || !Object.keys(this.data.authData).length || Object.keys(this.data.authData).length === 1 && Object.keys(this.data.authData)[0] === 'anonymous') {
      // We updated the email, send a new validation
      this.storage['sendVerificationEmail'] = true;
      this.config.userController.setEmailVerifyToken(this.data);
    }
  });
};

RestWrite.prototype._validatePasswordPolicy = function () {
  if (!this.config.passwordPolicy) return Promise.resolve();
  return this._validatePasswordRequirements().then(() => {
    return this._validatePasswordHistory();
  });
};

RestWrite.prototype._validatePasswordRequirements = function () {
  // check if the password conforms to the defined password policy if configured
  // If we specified a custom error in our configuration use it.
  // Example: "Passwords must include a Capital Letter, Lowercase Letter, and a number."
  //
  // This is especially useful on the generic "password reset" page,
  // as it allows the programmer to communicate specific requirements instead of:
  // a. making the user guess whats wrong
  // b. making a custom password reset page that shows the requirements
  const policyError = this.config.passwordPolicy.validationError ? this.config.passwordPolicy.validationError : 'Password does not meet the Password Policy requirements.';
  const containsUsernameError = 'Password cannot contain your username.'; // check whether the password meets the password strength requirements

  if (this.config.passwordPolicy.patternValidator && !this.config.passwordPolicy.patternValidator(this.data.password) || this.config.passwordPolicy.validatorCallback && !this.config.passwordPolicy.validatorCallback(this.data.password)) {
    return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, policyError));
  } // check whether password contain username


  if (this.config.passwordPolicy.doNotAllowUsername === true) {
    if (this.data.username) {
      // username is not passed during password reset
      if (this.data.password.indexOf(this.data.username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
    } else {
      // retrieve the User object using objectId during password reset
      return this.config.database.find('_User', {
        objectId: this.objectId()
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }

        if (this.data.password.indexOf(results[0].username) >= 0) return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, containsUsernameError));
        return Promise.resolve();
      });
    }
  }

  return Promise.resolve();
};

RestWrite.prototype._validatePasswordHistory = function () {
  // check whether password is repeating from specified history
  if (this.query && this.config.passwordPolicy.maxPasswordHistory) {
    return this.config.database.find('_User', {
      objectId: this.objectId()
    }, {
      keys: ['_password_history', '_hashed_password']
    }).then(results => {
      if (results.length != 1) {
        throw undefined;
      }

      const user = results[0];
      let oldPasswords = [];
      if (user._password_history) oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory - 1);
      oldPasswords.push(user.password);
      const newPassword = this.data.password; // compare the new password hash with all old password hashes

      const promises = oldPasswords.map(function (hash) {
        return passwordCrypto.compare(newPassword, hash).then(result => {
          if (result) // reject if there is a match
            return Promise.reject('REPEAT_PASSWORD');
          return Promise.resolve();
        });
      }); // wait for all comparisons to complete

      return Promise.all(promises).then(() => {
        return Promise.resolve();
      }).catch(err => {
        if (err === 'REPEAT_PASSWORD') // a match was found
          return Promise.reject(new Parse.Error(Parse.Error.VALIDATION_ERROR, `New password should not be the same as last ${this.config.passwordPolicy.maxPasswordHistory} passwords.`));
        throw err;
      });
    });
  }

  return Promise.resolve();
};

RestWrite.prototype.createSessionTokenIfNeeded = function () {
  if (this.className !== '_User') {
    return;
  }

  if (this.query) {
    return;
  }

  if (!this.storage['authProvider'] && // signup call, with
  this.config.preventLoginWithUnverifiedEmail && // no login without verification
  this.config.verifyUserEmails) {
    // verification is on
    return; // do not create the session token in that case!
  }

  return this.createSessionToken();
};

RestWrite.prototype.createSessionToken = function () {
  // cloud installationId from Cloud Code,
  // never create session tokens from there.
  if (this.auth.installationId && this.auth.installationId === 'cloud') {
    return;
  }

  const {
    sessionData,
    createSession
  } = Auth.createSession(this.config, {
    userId: this.objectId(),
    createdWith: {
      action: this.storage['authProvider'] ? 'login' : 'signup',
      authProvider: this.storage['authProvider'] || 'password'
    },
    installationId: this.auth.installationId
  });

  if (this.response && this.response.response) {
    this.response.response.sessionToken = sessionData.sessionToken;
  }

  return createSession();
}; // Delete email reset tokens if user is changing password or email.


RestWrite.prototype.deleteEmailResetTokenIfNeeded = function () {
  if (this.className !== '_User' || this.query === null) {
    // null query means create
    return;
  }

  if ('password' in this.data || 'email' in this.data) {
    const addOps = {
      _perishable_token: {
        __op: 'Delete'
      },
      _perishable_token_expires_at: {
        __op: 'Delete'
      }
    };
    this.data = Object.assign(this.data, addOps);
  }
};

RestWrite.prototype.destroyDuplicatedSessions = function () {
  // Only for _Session, and at creation time
  if (this.className != '_Session' || this.query) {
    return;
  } // Destroy the sessions in 'Background'


  const {
    user,
    installationId,
    sessionToken
  } = this.data;

  if (!user || !installationId) {
    return;
  }

  if (!user.objectId) {
    return;
  }

  this.config.database.destroy('_Session', {
    user,
    installationId,
    sessionToken: {
      $ne: sessionToken
    }
  });
}; // Handles any followup logic


RestWrite.prototype.handleFollowup = function () {
  if (this.storage && this.storage['clearSessions'] && this.config.revokeSessionOnPasswordReset) {
    var sessionQuery = {
      user: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.objectId()
      }
    };
    delete this.storage['clearSessions'];
    return this.config.database.destroy('_Session', sessionQuery).then(this.handleFollowup.bind(this));
  }

  if (this.storage && this.storage['generateNewSession']) {
    delete this.storage['generateNewSession'];
    return this.createSessionToken().then(this.handleFollowup.bind(this));
  }

  if (this.storage && this.storage['sendVerificationEmail']) {
    delete this.storage['sendVerificationEmail']; // Fire and forget!

    this.config.userController.sendVerificationEmail(this.data);
    return this.handleFollowup.bind(this);
  }
}; // Handles the _Session class specialness.
// Does nothing if this isn't an _Session object.


RestWrite.prototype.handleSession = function () {
  if (this.response || this.className !== '_Session') {
    return;
  }

  if (!this.auth.user && !this.auth.isMaster) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token required.');
  } // TODO: Verify proper error to throw


  if (this.data.ACL) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, 'Cannot set ' + 'ACL on a Session.');
  }

  if (this.query) {
    if (this.data.user && !this.auth.isMaster && this.data.user.objectId != this.auth.user.id) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.installationId) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    } else if (this.data.sessionToken) {
      throw new Parse.Error(Parse.Error.INVALID_KEY_NAME);
    }
  }

  if (!this.query && !this.auth.isMaster) {
    const additionalSessionData = {};

    for (var key in this.data) {
      if (key === 'objectId' || key === 'user') {
        continue;
      }

      additionalSessionData[key] = this.data[key];
    }

    const {
      sessionData,
      createSession
    } = Auth.createSession(this.config, {
      userId: this.auth.user.id,
      createdWith: {
        action: 'create'
      },
      additionalSessionData
    });
    return createSession().then(results => {
      if (!results.response) {
        throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Error creating session.');
      }

      sessionData['objectId'] = results.response['objectId'];
      this.response = {
        status: 201,
        location: results.location,
        response: sessionData
      };
    });
  }
}; // Handles the _Installation class specialness.
// Does nothing if this isn't an installation object.
// If an installation is found, this can mutate this.query and turn a create
// into an update.
// Returns a promise for when we're done if it can't finish this tick.


RestWrite.prototype.handleInstallation = function () {
  if (this.response || this.className !== '_Installation') {
    return;
  }

  if (!this.query && !this.data.deviceToken && !this.data.installationId && !this.auth.installationId) {
    throw new Parse.Error(135, 'at least one ID field (deviceToken, installationId) ' + 'must be specified in this operation');
  } // If the device token is 64 characters long, we assume it is for iOS
  // and lowercase it.


  if (this.data.deviceToken && this.data.deviceToken.length == 64) {
    this.data.deviceToken = this.data.deviceToken.toLowerCase();
  } // We lowercase the installationId if present


  if (this.data.installationId) {
    this.data.installationId = this.data.installationId.toLowerCase();
  }

  let installationId = this.data.installationId; // If data.installationId is not set and we're not master, we can lookup in auth

  if (!installationId && !this.auth.isMaster) {
    installationId = this.auth.installationId;
  }

  if (installationId) {
    installationId = installationId.toLowerCase();
  } // Updating _Installation but not updating anything critical


  if (this.query && !this.data.deviceToken && !installationId && !this.data.deviceType) {
    return;
  }

  var promise = Promise.resolve();
  var idMatch; // Will be a match on either objectId or installationId

  var objectIdMatch;
  var installationIdMatch;
  var deviceTokenMatches = []; // Instead of issuing 3 reads, let's do it with one OR.

  const orQueries = [];

  if (this.query && this.query.objectId) {
    orQueries.push({
      objectId: this.query.objectId
    });
  }

  if (installationId) {
    orQueries.push({
      installationId: installationId
    });
  }

  if (this.data.deviceToken) {
    orQueries.push({
      deviceToken: this.data.deviceToken
    });
  }

  if (orQueries.length == 0) {
    return;
  }

  promise = promise.then(() => {
    return this.config.database.find('_Installation', {
      $or: orQueries
    }, {});
  }).then(results => {
    results.forEach(result => {
      if (this.query && this.query.objectId && result.objectId == this.query.objectId) {
        objectIdMatch = result;
      }

      if (result.installationId == installationId) {
        installationIdMatch = result;
      }

      if (result.deviceToken == this.data.deviceToken) {
        deviceTokenMatches.push(result);
      }
    }); // Sanity checks when running a query

    if (this.query && this.query.objectId) {
      if (!objectIdMatch) {
        throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found for update.');
      }

      if (this.data.installationId && objectIdMatch.installationId && this.data.installationId !== objectIdMatch.installationId) {
        throw new Parse.Error(136, 'installationId may not be changed in this ' + 'operation');
      }

      if (this.data.deviceToken && objectIdMatch.deviceToken && this.data.deviceToken !== objectIdMatch.deviceToken && !this.data.installationId && !objectIdMatch.installationId) {
        throw new Parse.Error(136, 'deviceToken may not be changed in this ' + 'operation');
      }

      if (this.data.deviceType && this.data.deviceType && this.data.deviceType !== objectIdMatch.deviceType) {
        throw new Parse.Error(136, 'deviceType may not be changed in this ' + 'operation');
      }
    }

    if (this.query && this.query.objectId && objectIdMatch) {
      idMatch = objectIdMatch;
    }

    if (installationId && installationIdMatch) {
      idMatch = installationIdMatch;
    } // need to specify deviceType only if it's new


    if (!this.query && !this.data.deviceType && !idMatch) {
      throw new Parse.Error(135, 'deviceType must be specified in this operation');
    }
  }).then(() => {
    if (!idMatch) {
      if (!deviceTokenMatches.length) {
        return;
      } else if (deviceTokenMatches.length == 1 && (!deviceTokenMatches[0]['installationId'] || !installationId)) {
        // Single match on device token but none on installationId, and either
        // the passed object or the match is missing an installationId, so we
        // can just return the match.
        return deviceTokenMatches[0]['objectId'];
      } else if (!this.data.installationId) {
        throw new Parse.Error(132, 'Must specify installationId when deviceToken ' + 'matches multiple Installation objects');
      } else {
        // Multiple device token matches and we specified an installation ID,
        // or a single match where both the passed and matching objects have
        // an installation ID. Try cleaning out old installations that match
        // the deviceToken, and return nil to signal that a new object should
        // be created.
        var delQuery = {
          deviceToken: this.data.deviceToken,
          installationId: {
            $ne: installationId
          }
        };

        if (this.data.appIdentifier) {
          delQuery['appIdentifier'] = this.data.appIdentifier;
        }

        this.config.database.destroy('_Installation', delQuery).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored.
            return;
          } // rethrow the error


          throw err;
        });
        return;
      }
    } else {
      if (deviceTokenMatches.length == 1 && !deviceTokenMatches[0]['installationId']) {
        // Exactly one device token match and it doesn't have an installation
        // ID. This is the one case where we want to merge with the existing
        // object.
        const delQuery = {
          objectId: idMatch.objectId
        };
        return this.config.database.destroy('_Installation', delQuery).then(() => {
          return deviceTokenMatches[0]['objectId'];
        }).catch(err => {
          if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
            // no deletions were made. Can be ignored
            return;
          } // rethrow the error


          throw err;
        });
      } else {
        if (this.data.deviceToken && idMatch.deviceToken != this.data.deviceToken) {
          // We're setting the device token on an existing installation, so
          // we should try cleaning out old installations that match this
          // device token.
          const delQuery = {
            deviceToken: this.data.deviceToken
          }; // We have a unique install Id, use that to preserve
          // the interesting installation

          if (this.data.installationId) {
            delQuery['installationId'] = {
              $ne: this.data.installationId
            };
          } else if (idMatch.objectId && this.data.objectId && idMatch.objectId == this.data.objectId) {
            // we passed an objectId, preserve that instalation
            delQuery['objectId'] = {
              $ne: idMatch.objectId
            };
          } else {
            // What to do here? can't really clean up everything...
            return idMatch.objectId;
          }

          if (this.data.appIdentifier) {
            delQuery['appIdentifier'] = this.data.appIdentifier;
          }

          this.config.database.destroy('_Installation', delQuery).catch(err => {
            if (err.code == Parse.Error.OBJECT_NOT_FOUND) {
              // no deletions were made. Can be ignored.
              return;
            } // rethrow the error


            throw err;
          });
        } // In non-merge scenarios, just return the installation match id


        return idMatch.objectId;
      }
    }
  }).then(objId => {
    if (objId) {
      this.query = {
        objectId: objId
      };
      delete this.data.objectId;
      delete this.data.createdAt;
    } // TODO: Validate ops (add/remove on channels, $inc on badge, etc.)

  });
  return promise;
}; // If we short-circuted the object response - then we need to make sure we expand all the files,
// since this might not have a query, meaning it won't return the full result back.
// TODO: (nlutsenko) This should die when we move to per-class based controllers on _Session/_User


RestWrite.prototype.expandFilesForExistingObjects = function () {
  // Check whether we have a short-circuited response - only then run expansion.
  if (this.response && this.response.response) {
    this.config.filesController.expandFilesInObject(this.config, this.response.response);
  }
};

RestWrite.prototype.runDatabaseOperation = function () {
  if (this.response) {
    return;
  }

  if (this.className === '_Role') {
    this.config.cacheController.role.clear();
  }

  if (this.className === '_User' && this.query && this.auth.isUnauthenticated()) {
    throw new Parse.Error(Parse.Error.SESSION_MISSING, `Cannot modify user ${this.query.objectId}.`);
  }

  if (this.className === '_Product' && this.data.download) {
    this.data.downloadName = this.data.download.name;
  } // TODO: Add better detection for ACL, ensuring a user can't be locked from
  //       their own user record.


  if (this.data.ACL && this.data.ACL['*unresolved']) {
    throw new Parse.Error(Parse.Error.INVALID_ACL, 'Invalid ACL.');
  }

  if (this.query) {
    // Force the user to not lockout
    // Matched with parse.com
    if (this.className === '_User' && this.data.ACL && this.auth.isMaster !== true) {
      this.data.ACL[this.query.objectId] = {
        read: true,
        write: true
      };
    } // update password timestamp if user password is being changed


    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
      this.data._password_changed_at = Parse._encode(new Date());
    } // Ignore createdAt when update


    delete this.data.createdAt;
    let defer = Promise.resolve(); // if password history is enabled then save the current password to history

    if (this.className === '_User' && this.data._hashed_password && this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordHistory) {
      defer = this.config.database.find('_User', {
        objectId: this.objectId()
      }, {
        keys: ['_password_history', '_hashed_password']
      }).then(results => {
        if (results.length != 1) {
          throw undefined;
        }

        const user = results[0];
        let oldPasswords = [];

        if (user._password_history) {
          oldPasswords = _lodash.default.take(user._password_history, this.config.passwordPolicy.maxPasswordHistory);
        } //n-1 passwords go into history including last password


        while (oldPasswords.length > Math.max(0, this.config.passwordPolicy.maxPasswordHistory - 2)) {
          oldPasswords.shift();
        }

        oldPasswords.push(user.password);
        this.data._password_history = oldPasswords;
      });
    }

    return defer.then(() => {
      // Run an update
      return this.config.database.update(this.className, this.query, this.data, this.runOptions).then(response => {
        response.updatedAt = this.updatedAt;

        this._updateResponseWithData(response, this.data);

        this.response = {
          response
        };
      });
    });
  } else {
    // Set the default ACL and password timestamp for the new _User
    if (this.className === '_User') {
      var ACL = this.data.ACL; // default public r/w ACL

      if (!ACL) {
        ACL = {};
        ACL['*'] = {
          read: true,
          write: false
        };
      } // make sure the user is not locked down


      ACL[this.data.objectId] = {
        read: true,
        write: true
      };
      this.data.ACL = ACL; // password timestamp to be used when password expiry policy is enforced

      if (this.config.passwordPolicy && this.config.passwordPolicy.maxPasswordAge) {
        this.data._password_changed_at = Parse._encode(new Date());
      }
    } // Run a create


    return this.config.database.create(this.className, this.data, this.runOptions).catch(error => {
      if (this.className !== '_User' || error.code !== Parse.Error.DUPLICATE_VALUE) {
        throw error;
      } // Quick check, if we were able to infer the duplicated field name


      if (error && error.userInfo && error.userInfo.duplicated_field === 'username') {
        throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
      }

      if (error && error.userInfo && error.userInfo.duplicated_field === 'email') {
        throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
      } // If this was a failed user creation due to username or email already taken, we need to
      // check whether it was username or email and return the appropriate error.
      // Fallback to the original method
      // TODO: See if we can later do this without additional queries by using named indexes.


      return this.config.database.find(this.className, {
        username: this.data.username,
        objectId: {
          $ne: this.objectId()
        }
      }, {
        limit: 1
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.USERNAME_TAKEN, 'Account already exists for this username.');
        }

        return this.config.database.find(this.className, {
          email: this.data.email,
          objectId: {
            $ne: this.objectId()
          }
        }, {
          limit: 1
        });
      }).then(results => {
        if (results.length > 0) {
          throw new Parse.Error(Parse.Error.EMAIL_TAKEN, 'Account already exists for this email address.');
        }

        throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      });
    }).then(response => {
      response.objectId = this.data.objectId;
      response.createdAt = this.data.createdAt;

      if (this.responseShouldHaveUsername) {
        response.username = this.data.username;
      }

      this._updateResponseWithData(response, this.data);

      this.response = {
        status: 201,
        response,
        location: this.location()
      };
    });
  }
}; // Returns nothing - doesn't wait for the trigger.


RestWrite.prototype.runAfterSaveTrigger = function () {
  if (!this.response || !this.response.response) {
    return;
  } // Avoid doing any setup for triggers if there is no 'afterSave' trigger for this class.


  const hasAfterSaveHook = triggers.triggerExists(this.className, triggers.Types.afterSave, this.config.applicationId);
  const hasLiveQuery = this.config.liveQueryController.hasLiveQuery(this.className);

  if (!hasAfterSaveHook && !hasLiveQuery) {
    return Promise.resolve();
  }

  var extraData = {
    className: this.className
  };

  if (this.query && this.query.objectId) {
    extraData.objectId = this.query.objectId;
  } // Build the original object, we only do this for a update write.


  let originalObject;

  if (this.query && this.query.objectId) {
    originalObject = triggers.inflate(extraData, this.originalData);
  } // Build the inflated object, different from beforeSave, originalData is not empty
  // since developers can change data in the beforeSave.


  const updatedObject = this.buildUpdatedObject(extraData);

  updatedObject._handleSaveResponse(this.response.response, this.response.status || 200);

  this.config.database.loadSchema().then(schemaController => {
    // Notifiy LiveQueryServer if possible
    const perms = schemaController.getClassLevelPermissions(updatedObject.className);
    this.config.liveQueryController.onAfterSave(updatedObject.className, updatedObject, originalObject, perms);
  }); // Run afterSave trigger

  return triggers.maybeRunTrigger(triggers.Types.afterSave, this.auth, updatedObject, originalObject, this.config, this.context).catch(function (err) {
    _logger.default.warn('afterSave caught an error', err);
  });
}; // A helper to figure out what location this operation happens at.


RestWrite.prototype.location = function () {
  var middle = this.className === '_User' ? '/users/' : '/classes/' + this.className + '/';
  return this.config.mount + middle + this.data.objectId;
}; // A helper to get the object id for this operation.
// Because it could be either on the query or on the data


RestWrite.prototype.objectId = function () {
  return this.data.objectId || this.query.objectId;
}; // Returns a copy of the data and delete bad keys (_auth_data, _hashed_password...)


RestWrite.prototype.sanitizedData = function () {
  const data = Object.keys(this.data).reduce((data, key) => {
    // Regexp comes from Parse.Object.prototype.validate
    if (!/^[A-Za-z][0-9A-Za-z_]*$/.test(key)) {
      delete data[key];
    }

    return data;
  }, deepcopy(this.data));
  return Parse._decode(undefined, data);
}; // Returns an updated copy of the object


RestWrite.prototype.buildUpdatedObject = function (extraData) {
  const updatedObject = triggers.inflate(extraData, this.originalData);
  Object.keys(this.data).reduce(function (data, key) {
    if (key.indexOf('.') > 0) {
      // subdocument key with dot notation ('x.y':v => 'x':{'y':v})
      const splittedKey = key.split('.');
      const parentProp = splittedKey[0];
      let parentVal = updatedObject.get(parentProp);

      if (typeof parentVal !== 'object') {
        parentVal = {};
      }

      parentVal[splittedKey[1]] = data[key];
      updatedObject.set(parentProp, parentVal);
      delete data[key];
    }

    return data;
  }, deepcopy(this.data));
  updatedObject.set(this.sanitizedData());
  return updatedObject;
};

RestWrite.prototype.cleanUserAuthData = function () {
  if (this.response && this.response.response && this.className === '_User') {
    const user = this.response.response;

    if (user.authData) {
      Object.keys(user.authData).forEach(provider => {
        if (user.authData[provider] === null) {
          delete user.authData[provider];
        }
      });

      if (Object.keys(user.authData).length == 0) {
        delete user.authData;
      }
    }
  }
};

RestWrite.prototype._updateResponseWithData = function (response, data) {
  if (_lodash.default.isEmpty(this.storage.fieldsChangedByTrigger)) {
    return response;
  }

  const clientSupportsDelete = ClientSDK.supportsForwardDelete(this.clientSDK);
  this.storage.fieldsChangedByTrigger.forEach(fieldName => {
    const dataValue = data[fieldName];

    if (!response.hasOwnProperty(fieldName)) {
      response[fieldName] = dataValue;
    } // Strips operations from responses


    if (response[fieldName] && response[fieldName].__op) {
      delete response[fieldName];

      if (clientSupportsDelete && dataValue.__op == 'Delete') {
        response[fieldName] = dataValue;
      }
    }
  });
  return response;
};

var _default = RestWrite;
exports.default = _default;
module.exports = RestWrite;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9SZXN0V3JpdGUuanMiXSwibmFtZXMiOlsiU2NoZW1hQ29udHJvbGxlciIsInJlcXVpcmUiLCJkZWVwY29weSIsIkF1dGgiLCJjcnlwdG9VdGlscyIsInBhc3N3b3JkQ3J5cHRvIiwiUGFyc2UiLCJ0cmlnZ2VycyIsIkNsaWVudFNESyIsIlJlc3RXcml0ZSIsImNvbmZpZyIsImF1dGgiLCJjbGFzc05hbWUiLCJxdWVyeSIsImRhdGEiLCJvcmlnaW5hbERhdGEiLCJjbGllbnRTREsiLCJpc1JlYWRPbmx5IiwiRXJyb3IiLCJPUEVSQVRJT05fRk9SQklEREVOIiwic3RvcmFnZSIsInJ1bk9wdGlvbnMiLCJjb250ZXh0Iiwib2JqZWN0SWQiLCJJTlZBTElEX0tFWV9OQU1FIiwicmVzcG9uc2UiLCJ1cGRhdGVkQXQiLCJfZW5jb2RlIiwiRGF0ZSIsImlzbyIsInByb3RvdHlwZSIsImV4ZWN1dGUiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJnZXRVc2VyQW5kUm9sZUFDTCIsInZhbGlkYXRlQ2xpZW50Q2xhc3NDcmVhdGlvbiIsImhhbmRsZUluc3RhbGxhdGlvbiIsImhhbmRsZVNlc3Npb24iLCJ2YWxpZGF0ZUF1dGhEYXRhIiwicnVuQmVmb3JlU2F2ZVRyaWdnZXIiLCJkZWxldGVFbWFpbFJlc2V0VG9rZW5JZk5lZWRlZCIsInZhbGlkYXRlU2NoZW1hIiwic2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCIsInRyYW5zZm9ybVVzZXIiLCJleHBhbmRGaWxlc0ZvckV4aXN0aW5nT2JqZWN0cyIsImRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMiLCJydW5EYXRhYmFzZU9wZXJhdGlvbiIsImNyZWF0ZVNlc3Npb25Ub2tlbklmTmVlZGVkIiwiaGFuZGxlRm9sbG93dXAiLCJydW5BZnRlclNhdmVUcmlnZ2VyIiwiY2xlYW5Vc2VyQXV0aERhdGEiLCJpc01hc3RlciIsImFjbCIsInVzZXIiLCJnZXRVc2VyUm9sZXMiLCJyb2xlcyIsImNvbmNhdCIsImlkIiwiYWxsb3dDbGllbnRDbGFzc0NyZWF0aW9uIiwic3lzdGVtQ2xhc3NlcyIsImluZGV4T2YiLCJkYXRhYmFzZSIsImxvYWRTY2hlbWEiLCJzY2hlbWFDb250cm9sbGVyIiwiaGFzQ2xhc3MiLCJ2YWxpZGF0ZU9iamVjdCIsInRyaWdnZXJFeGlzdHMiLCJUeXBlcyIsImJlZm9yZVNhdmUiLCJhcHBsaWNhdGlvbklkIiwiZXh0cmFEYXRhIiwib3JpZ2luYWxPYmplY3QiLCJ1cGRhdGVkT2JqZWN0IiwiYnVpbGRVcGRhdGVkT2JqZWN0IiwiaW5mbGF0ZSIsImRhdGFiYXNlUHJvbWlzZSIsInVwZGF0ZSIsImNyZWF0ZSIsInJlc3VsdCIsImxlbmd0aCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJtYXliZVJ1blRyaWdnZXIiLCJvYmplY3QiLCJmaWVsZHNDaGFuZ2VkQnlUcmlnZ2VyIiwiXyIsInJlZHVjZSIsInZhbHVlIiwia2V5IiwiaXNFcXVhbCIsInB1c2giLCJydW5CZWZvcmVMb2dpblRyaWdnZXIiLCJ1c2VyRGF0YSIsImJlZm9yZUxvZ2luIiwiY3JlYXRlZEF0IiwibmV3T2JqZWN0SWQiLCJvYmplY3RJZFNpemUiLCJhdXRoRGF0YSIsInVzZXJuYW1lIiwiaXNFbXB0eSIsIlVTRVJOQU1FX01JU1NJTkciLCJwYXNzd29yZCIsIlBBU1NXT1JEX01JU1NJTkciLCJPYmplY3QiLCJrZXlzIiwicHJvdmlkZXJzIiwiY2FuSGFuZGxlQXV0aERhdGEiLCJjYW5IYW5kbGUiLCJwcm92aWRlciIsInByb3ZpZGVyQXV0aERhdGEiLCJoYXNUb2tlbiIsImhhbmRsZUF1dGhEYXRhIiwiVU5TVVBQT1JURURfU0VSVklDRSIsImhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbiIsInZhbGlkYXRpb25zIiwibWFwIiwiYXV0aERhdGFNYW5hZ2VyIiwiZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIiLCJhbGwiLCJmaW5kVXNlcnNXaXRoQXV0aERhdGEiLCJtZW1vIiwicXVlcnlLZXkiLCJmaWx0ZXIiLCJxIiwiZmluZFByb21pc2UiLCJmaW5kIiwiJG9yIiwiZmlsdGVyZWRPYmplY3RzQnlBQ0wiLCJvYmplY3RzIiwiQUNMIiwicmVzdWx0cyIsInIiLCJBQ0NPVU5UX0FMUkVBRFlfTElOS0VEIiwiam9pbiIsInVzZXJSZXN1bHQiLCJtdXRhdGVkQXV0aERhdGEiLCJmb3JFYWNoIiwicHJvdmlkZXJEYXRhIiwidXNlckF1dGhEYXRhIiwiaGFzTXV0YXRlZEF1dGhEYXRhIiwidXNlcklkIiwibG9jYXRpb24iLCJwcm9taXNlIiwiZXJyb3IiLCJSZXN0UXVlcnkiLCJtYXN0ZXIiLCJfX3R5cGUiLCJzZXNzaW9uIiwiY2FjaGVDb250cm9sbGVyIiwiZGVsIiwic2Vzc2lvblRva2VuIiwidW5kZWZpbmVkIiwiX3ZhbGlkYXRlUGFzc3dvcmRQb2xpY3kiLCJoYXNoIiwiaGFzaGVkUGFzc3dvcmQiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3ZhbGlkYXRlVXNlck5hbWUiLCJfdmFsaWRhdGVFbWFpbCIsInJhbmRvbVN0cmluZyIsInJlc3BvbnNlU2hvdWxkSGF2ZVVzZXJuYW1lIiwiJG5lIiwibGltaXQiLCJVU0VSTkFNRV9UQUtFTiIsImVtYWlsIiwiX19vcCIsIm1hdGNoIiwicmVqZWN0IiwiSU5WQUxJRF9FTUFJTF9BRERSRVNTIiwiRU1BSUxfVEFLRU4iLCJ1c2VyQ29udHJvbGxlciIsInNldEVtYWlsVmVyaWZ5VG9rZW4iLCJwYXNzd29yZFBvbGljeSIsIl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzIiwiX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5IiwicG9saWN5RXJyb3IiLCJ2YWxpZGF0aW9uRXJyb3IiLCJjb250YWluc1VzZXJuYW1lRXJyb3IiLCJwYXR0ZXJuVmFsaWRhdG9yIiwidmFsaWRhdG9yQ2FsbGJhY2siLCJWQUxJREFUSU9OX0VSUk9SIiwiZG9Ob3RBbGxvd1VzZXJuYW1lIiwibWF4UGFzc3dvcmRIaXN0b3J5Iiwib2xkUGFzc3dvcmRzIiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJ0YWtlIiwibmV3UGFzc3dvcmQiLCJwcm9taXNlcyIsImNvbXBhcmUiLCJjYXRjaCIsImVyciIsInByZXZlbnRMb2dpbldpdGhVbnZlcmlmaWVkRW1haWwiLCJ2ZXJpZnlVc2VyRW1haWxzIiwiY3JlYXRlU2Vzc2lvblRva2VuIiwiaW5zdGFsbGF0aW9uSWQiLCJzZXNzaW9uRGF0YSIsImNyZWF0ZVNlc3Npb24iLCJjcmVhdGVkV2l0aCIsImFjdGlvbiIsImF1dGhQcm92aWRlciIsImFkZE9wcyIsIl9wZXJpc2hhYmxlX3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCIsImFzc2lnbiIsImRlc3Ryb3kiLCJyZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0Iiwic2Vzc2lvblF1ZXJ5IiwiYmluZCIsInNlbmRWZXJpZmljYXRpb25FbWFpbCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsImFkZGl0aW9uYWxTZXNzaW9uRGF0YSIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsInN0YXR1cyIsImRldmljZVRva2VuIiwidG9Mb3dlckNhc2UiLCJkZXZpY2VUeXBlIiwiaWRNYXRjaCIsIm9iamVjdElkTWF0Y2giLCJpbnN0YWxsYXRpb25JZE1hdGNoIiwiZGV2aWNlVG9rZW5NYXRjaGVzIiwib3JRdWVyaWVzIiwiZGVsUXVlcnkiLCJhcHBJZGVudGlmaWVyIiwiY29kZSIsIm9iaklkIiwiZmlsZXNDb250cm9sbGVyIiwiZXhwYW5kRmlsZXNJbk9iamVjdCIsInJvbGUiLCJjbGVhciIsImlzVW5hdXRoZW50aWNhdGVkIiwiU0VTU0lPTl9NSVNTSU5HIiwiZG93bmxvYWQiLCJkb3dubG9hZE5hbWUiLCJuYW1lIiwiSU5WQUxJRF9BQ0wiLCJyZWFkIiwid3JpdGUiLCJtYXhQYXNzd29yZEFnZSIsIl9wYXNzd29yZF9jaGFuZ2VkX2F0IiwiZGVmZXIiLCJNYXRoIiwibWF4Iiwic2hpZnQiLCJfdXBkYXRlUmVzcG9uc2VXaXRoRGF0YSIsIkRVUExJQ0FURV9WQUxVRSIsInVzZXJJbmZvIiwiZHVwbGljYXRlZF9maWVsZCIsImhhc0FmdGVyU2F2ZUhvb2siLCJhZnRlclNhdmUiLCJoYXNMaXZlUXVlcnkiLCJsaXZlUXVlcnlDb250cm9sbGVyIiwiX2hhbmRsZVNhdmVSZXNwb25zZSIsInBlcm1zIiwiZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zIiwib25BZnRlclNhdmUiLCJsb2dnZXIiLCJ3YXJuIiwibWlkZGxlIiwibW91bnQiLCJzYW5pdGl6ZWREYXRhIiwidGVzdCIsIl9kZWNvZGUiLCJzcGxpdHRlZEtleSIsInNwbGl0IiwicGFyZW50UHJvcCIsInBhcmVudFZhbCIsImdldCIsInNldCIsImNsaWVudFN1cHBvcnRzRGVsZXRlIiwic3VwcG9ydHNGb3J3YXJkRGVsZXRlIiwiZmllbGROYW1lIiwiZGF0YVZhbHVlIiwiaGFzT3duUHJvcGVydHkiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBYUE7O0FBQ0E7O0FBQ0E7Ozs7QUFmQTtBQUNBO0FBQ0E7QUFFQSxJQUFJQSxnQkFBZ0IsR0FBR0MsT0FBTyxDQUFDLGdDQUFELENBQTlCOztBQUNBLElBQUlDLFFBQVEsR0FBR0QsT0FBTyxDQUFDLFVBQUQsQ0FBdEI7O0FBRUEsTUFBTUUsSUFBSSxHQUFHRixPQUFPLENBQUMsUUFBRCxDQUFwQjs7QUFDQSxJQUFJRyxXQUFXLEdBQUdILE9BQU8sQ0FBQyxlQUFELENBQXpCOztBQUNBLElBQUlJLGNBQWMsR0FBR0osT0FBTyxDQUFDLFlBQUQsQ0FBNUI7O0FBQ0EsSUFBSUssS0FBSyxHQUFHTCxPQUFPLENBQUMsWUFBRCxDQUFuQjs7QUFDQSxJQUFJTSxRQUFRLEdBQUdOLE9BQU8sQ0FBQyxZQUFELENBQXRCOztBQUNBLElBQUlPLFNBQVMsR0FBR1AsT0FBTyxDQUFDLGFBQUQsQ0FBdkI7O0FBS0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBU1EsU0FBVCxDQUNFQyxNQURGLEVBRUVDLElBRkYsRUFHRUMsU0FIRixFQUlFQyxLQUpGLEVBS0VDLElBTEYsRUFNRUMsWUFORixFQU9FQyxTQVBGLEVBUUU7QUFDQSxNQUFJTCxJQUFJLENBQUNNLFVBQVQsRUFBcUI7QUFDbkIsVUFBTSxJQUFJWCxLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVlDLG1CQURSLEVBRUosK0RBRkksQ0FBTjtBQUlEOztBQUNELE9BQUtULE1BQUwsR0FBY0EsTUFBZDtBQUNBLE9BQUtDLElBQUwsR0FBWUEsSUFBWjtBQUNBLE9BQUtDLFNBQUwsR0FBaUJBLFNBQWpCO0FBQ0EsT0FBS0ksU0FBTCxHQUFpQkEsU0FBakI7QUFDQSxPQUFLSSxPQUFMLEdBQWUsRUFBZjtBQUNBLE9BQUtDLFVBQUwsR0FBa0IsRUFBbEI7QUFDQSxPQUFLQyxPQUFMLEdBQWUsRUFBZjs7QUFDQSxNQUFJLENBQUNULEtBQUQsSUFBVUMsSUFBSSxDQUFDUyxRQUFuQixFQUE2QjtBQUMzQixVQUFNLElBQUlqQixLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVlNLGdCQURSLEVBRUosb0NBRkksQ0FBTjtBQUlELEdBbkJELENBcUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBLE9BQUtDLFFBQUwsR0FBZ0IsSUFBaEIsQ0ExQkEsQ0E0QkE7QUFDQTs7QUFDQSxPQUFLWixLQUFMLEdBQWFYLFFBQVEsQ0FBQ1csS0FBRCxDQUFyQjtBQUNBLE9BQUtDLElBQUwsR0FBWVosUUFBUSxDQUFDWSxJQUFELENBQXBCLENBL0JBLENBZ0NBOztBQUNBLE9BQUtDLFlBQUwsR0FBb0JBLFlBQXBCLENBakNBLENBbUNBOztBQUNBLE9BQUtXLFNBQUwsR0FBaUJwQixLQUFLLENBQUNxQixPQUFOLENBQWMsSUFBSUMsSUFBSixFQUFkLEVBQTBCQyxHQUEzQztBQUNELEMsQ0FFRDtBQUNBO0FBQ0E7QUFDQTs7O0FBQ0FwQixTQUFTLENBQUNxQixTQUFWLENBQW9CQyxPQUFwQixHQUE4QixZQUFXO0FBQ3ZDLFNBQU9DLE9BQU8sQ0FBQ0MsT0FBUixHQUNKQyxJQURJLENBQ0MsTUFBTTtBQUNWLFdBQU8sS0FBS0MsaUJBQUwsRUFBUDtBQUNELEdBSEksRUFJSkQsSUFKSSxDQUlDLE1BQU07QUFDVixXQUFPLEtBQUtFLDJCQUFMLEVBQVA7QUFDRCxHQU5JLEVBT0pGLElBUEksQ0FPQyxNQUFNO0FBQ1YsV0FBTyxLQUFLRyxrQkFBTCxFQUFQO0FBQ0QsR0FUSSxFQVVKSCxJQVZJLENBVUMsTUFBTTtBQUNWLFdBQU8sS0FBS0ksYUFBTCxFQUFQO0FBQ0QsR0FaSSxFQWFKSixJQWJJLENBYUMsTUFBTTtBQUNWLFdBQU8sS0FBS0ssZ0JBQUwsRUFBUDtBQUNELEdBZkksRUFnQkpMLElBaEJJLENBZ0JDLE1BQU07QUFDVixXQUFPLEtBQUtNLG9CQUFMLEVBQVA7QUFDRCxHQWxCSSxFQW1CSk4sSUFuQkksQ0FtQkMsTUFBTTtBQUNWLFdBQU8sS0FBS08sNkJBQUwsRUFBUDtBQUNELEdBckJJLEVBc0JKUCxJQXRCSSxDQXNCQyxNQUFNO0FBQ1YsV0FBTyxLQUFLUSxjQUFMLEVBQVA7QUFDRCxHQXhCSSxFQXlCSlIsSUF6QkksQ0F5QkMsTUFBTTtBQUNWLFdBQU8sS0FBS1MseUJBQUwsRUFBUDtBQUNELEdBM0JJLEVBNEJKVCxJQTVCSSxDQTRCQyxNQUFNO0FBQ1YsV0FBTyxLQUFLVSxhQUFMLEVBQVA7QUFDRCxHQTlCSSxFQStCSlYsSUEvQkksQ0ErQkMsTUFBTTtBQUNWLFdBQU8sS0FBS1csNkJBQUwsRUFBUDtBQUNELEdBakNJLEVBa0NKWCxJQWxDSSxDQWtDQyxNQUFNO0FBQ1YsV0FBTyxLQUFLWSx5QkFBTCxFQUFQO0FBQ0QsR0FwQ0ksRUFxQ0paLElBckNJLENBcUNDLE1BQU07QUFDVixXQUFPLEtBQUthLG9CQUFMLEVBQVA7QUFDRCxHQXZDSSxFQXdDSmIsSUF4Q0ksQ0F3Q0MsTUFBTTtBQUNWLFdBQU8sS0FBS2MsMEJBQUwsRUFBUDtBQUNELEdBMUNJLEVBMkNKZCxJQTNDSSxDQTJDQyxNQUFNO0FBQ1YsV0FBTyxLQUFLZSxjQUFMLEVBQVA7QUFDRCxHQTdDSSxFQThDSmYsSUE5Q0ksQ0E4Q0MsTUFBTTtBQUNWLFdBQU8sS0FBS2dCLG1CQUFMLEVBQVA7QUFDRCxHQWhESSxFQWlESmhCLElBakRJLENBaURDLE1BQU07QUFDVixXQUFPLEtBQUtpQixpQkFBTCxFQUFQO0FBQ0QsR0FuREksRUFvREpqQixJQXBESSxDQW9EQyxNQUFNO0FBQ1YsV0FBTyxLQUFLVCxRQUFaO0FBQ0QsR0F0REksQ0FBUDtBQXVERCxDQXhERCxDLENBMERBOzs7QUFDQWhCLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JLLGlCQUFwQixHQUF3QyxZQUFXO0FBQ2pELE1BQUksS0FBS3hCLElBQUwsQ0FBVXlDLFFBQWQsRUFBd0I7QUFDdEIsV0FBT3BCLE9BQU8sQ0FBQ0MsT0FBUixFQUFQO0FBQ0Q7O0FBRUQsT0FBS1osVUFBTCxDQUFnQmdDLEdBQWhCLEdBQXNCLENBQUMsR0FBRCxDQUF0Qjs7QUFFQSxNQUFJLEtBQUsxQyxJQUFMLENBQVUyQyxJQUFkLEVBQW9CO0FBQ2xCLFdBQU8sS0FBSzNDLElBQUwsQ0FBVTRDLFlBQVYsR0FBeUJyQixJQUF6QixDQUE4QnNCLEtBQUssSUFBSTtBQUM1QyxXQUFLbkMsVUFBTCxDQUFnQmdDLEdBQWhCLEdBQXNCLEtBQUtoQyxVQUFMLENBQWdCZ0MsR0FBaEIsQ0FBb0JJLE1BQXBCLENBQTJCRCxLQUEzQixFQUFrQyxDQUN0RCxLQUFLN0MsSUFBTCxDQUFVMkMsSUFBVixDQUFlSSxFQUR1QyxDQUFsQyxDQUF0QjtBQUdBO0FBQ0QsS0FMTSxDQUFQO0FBTUQsR0FQRCxNQU9PO0FBQ0wsV0FBTzFCLE9BQU8sQ0FBQ0MsT0FBUixFQUFQO0FBQ0Q7QUFDRixDQWpCRCxDLENBbUJBOzs7QUFDQXhCLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JNLDJCQUFwQixHQUFrRCxZQUFXO0FBQzNELE1BQ0UsS0FBSzFCLE1BQUwsQ0FBWWlELHdCQUFaLEtBQXlDLEtBQXpDLElBQ0EsQ0FBQyxLQUFLaEQsSUFBTCxDQUFVeUMsUUFEWCxJQUVBcEQsZ0JBQWdCLENBQUM0RCxhQUFqQixDQUErQkMsT0FBL0IsQ0FBdUMsS0FBS2pELFNBQTVDLE1BQTJELENBQUMsQ0FIOUQsRUFJRTtBQUNBLFdBQU8sS0FBS0YsTUFBTCxDQUFZb0QsUUFBWixDQUNKQyxVQURJLEdBRUo3QixJQUZJLENBRUM4QixnQkFBZ0IsSUFBSUEsZ0JBQWdCLENBQUNDLFFBQWpCLENBQTBCLEtBQUtyRCxTQUEvQixDQUZyQixFQUdKc0IsSUFISSxDQUdDK0IsUUFBUSxJQUFJO0FBQ2hCLFVBQUlBLFFBQVEsS0FBSyxJQUFqQixFQUF1QjtBQUNyQixjQUFNLElBQUkzRCxLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVlDLG1CQURSLEVBRUosd0NBQ0Usc0JBREYsR0FFRSxLQUFLUCxTQUpILENBQU47QUFNRDtBQUNGLEtBWkksQ0FBUDtBQWFELEdBbEJELE1Ba0JPO0FBQ0wsV0FBT29CLE9BQU8sQ0FBQ0MsT0FBUixFQUFQO0FBQ0Q7QUFDRixDQXRCRCxDLENBd0JBOzs7QUFDQXhCLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JZLGNBQXBCLEdBQXFDLFlBQVc7QUFDOUMsU0FBTyxLQUFLaEMsTUFBTCxDQUFZb0QsUUFBWixDQUFxQkksY0FBckIsQ0FDTCxLQUFLdEQsU0FEQSxFQUVMLEtBQUtFLElBRkEsRUFHTCxLQUFLRCxLQUhBLEVBSUwsS0FBS1EsVUFKQSxDQUFQO0FBTUQsQ0FQRCxDLENBU0E7QUFDQTs7O0FBQ0FaLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JVLG9CQUFwQixHQUEyQyxZQUFXO0FBQ3BELE1BQUksS0FBS2YsUUFBVCxFQUFtQjtBQUNqQjtBQUNELEdBSG1ELENBS3BEOzs7QUFDQSxNQUNFLENBQUNsQixRQUFRLENBQUM0RCxhQUFULENBQ0MsS0FBS3ZELFNBRE4sRUFFQ0wsUUFBUSxDQUFDNkQsS0FBVCxDQUFlQyxVQUZoQixFQUdDLEtBQUszRCxNQUFMLENBQVk0RCxhQUhiLENBREgsRUFNRTtBQUNBLFdBQU90QyxPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNELEdBZG1ELENBZ0JwRDs7O0FBQ0EsTUFBSXNDLFNBQVMsR0FBRztBQUFFM0QsSUFBQUEsU0FBUyxFQUFFLEtBQUtBO0FBQWxCLEdBQWhCOztBQUNBLE1BQUksS0FBS0MsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBN0IsRUFBdUM7QUFDckNnRCxJQUFBQSxTQUFTLENBQUNoRCxRQUFWLEdBQXFCLEtBQUtWLEtBQUwsQ0FBV1UsUUFBaEM7QUFDRDs7QUFFRCxNQUFJaUQsY0FBYyxHQUFHLElBQXJCO0FBQ0EsUUFBTUMsYUFBYSxHQUFHLEtBQUtDLGtCQUFMLENBQXdCSCxTQUF4QixDQUF0Qjs7QUFDQSxNQUFJLEtBQUsxRCxLQUFMLElBQWMsS0FBS0EsS0FBTCxDQUFXVSxRQUE3QixFQUF1QztBQUNyQztBQUNBaUQsSUFBQUEsY0FBYyxHQUFHakUsUUFBUSxDQUFDb0UsT0FBVCxDQUFpQkosU0FBakIsRUFBNEIsS0FBS3hELFlBQWpDLENBQWpCO0FBQ0Q7O0FBRUQsU0FBT2lCLE9BQU8sQ0FBQ0MsT0FBUixHQUNKQyxJQURJLENBQ0MsTUFBTTtBQUNWO0FBQ0EsUUFBSTBDLGVBQWUsR0FBRyxJQUF0Qjs7QUFDQSxRQUFJLEtBQUsvRCxLQUFULEVBQWdCO0FBQ2Q7QUFDQStELE1BQUFBLGVBQWUsR0FBRyxLQUFLbEUsTUFBTCxDQUFZb0QsUUFBWixDQUFxQmUsTUFBckIsQ0FDaEIsS0FBS2pFLFNBRFcsRUFFaEIsS0FBS0MsS0FGVyxFQUdoQixLQUFLQyxJQUhXLEVBSWhCLEtBQUtPLFVBSlcsRUFLaEIsS0FMZ0IsRUFNaEIsSUFOZ0IsQ0FBbEI7QUFRRCxLQVZELE1BVU87QUFDTDtBQUNBdUQsTUFBQUEsZUFBZSxHQUFHLEtBQUtsRSxNQUFMLENBQVlvRCxRQUFaLENBQXFCZ0IsTUFBckIsQ0FDaEIsS0FBS2xFLFNBRFcsRUFFaEIsS0FBS0UsSUFGVyxFQUdoQixLQUFLTyxVQUhXLEVBSWhCLElBSmdCLENBQWxCO0FBTUQsS0FyQlMsQ0FzQlY7OztBQUNBLFdBQU91RCxlQUFlLENBQUMxQyxJQUFoQixDQUFxQjZDLE1BQU0sSUFBSTtBQUNwQyxVQUFJLENBQUNBLE1BQUQsSUFBV0EsTUFBTSxDQUFDQyxNQUFQLElBQWlCLENBQWhDLEVBQW1DO0FBQ2pDLGNBQU0sSUFBSTFFLEtBQUssQ0FBQ1ksS0FBVixDQUNKWixLQUFLLENBQUNZLEtBQU4sQ0FBWStELGdCQURSLEVBRUosbUJBRkksQ0FBTjtBQUlEO0FBQ0YsS0FQTSxDQUFQO0FBUUQsR0FoQ0ksRUFpQ0ovQyxJQWpDSSxDQWlDQyxNQUFNO0FBQ1YsV0FBTzNCLFFBQVEsQ0FBQzJFLGVBQVQsQ0FDTDNFLFFBQVEsQ0FBQzZELEtBQVQsQ0FBZUMsVUFEVixFQUVMLEtBQUsxRCxJQUZBLEVBR0w4RCxhQUhLLEVBSUxELGNBSkssRUFLTCxLQUFLOUQsTUFMQSxFQU1MLEtBQUtZLE9BTkEsQ0FBUDtBQVFELEdBMUNJLEVBMkNKWSxJQTNDSSxDQTJDQ1QsUUFBUSxJQUFJO0FBQ2hCLFFBQUlBLFFBQVEsSUFBSUEsUUFBUSxDQUFDMEQsTUFBekIsRUFBaUM7QUFDL0IsV0FBSy9ELE9BQUwsQ0FBYWdFLHNCQUFiLEdBQXNDQyxnQkFBRUMsTUFBRixDQUNwQzdELFFBQVEsQ0FBQzBELE1BRDJCLEVBRXBDLENBQUNKLE1BQUQsRUFBU1EsS0FBVCxFQUFnQkMsR0FBaEIsS0FBd0I7QUFDdEIsWUFBSSxDQUFDSCxnQkFBRUksT0FBRixDQUFVLEtBQUszRSxJQUFMLENBQVUwRSxHQUFWLENBQVYsRUFBMEJELEtBQTFCLENBQUwsRUFBdUM7QUFDckNSLFVBQUFBLE1BQU0sQ0FBQ1csSUFBUCxDQUFZRixHQUFaO0FBQ0Q7O0FBQ0QsZUFBT1QsTUFBUDtBQUNELE9BUG1DLEVBUXBDLEVBUm9DLENBQXRDO0FBVUEsV0FBS2pFLElBQUwsR0FBWVcsUUFBUSxDQUFDMEQsTUFBckIsQ0FYK0IsQ0FZL0I7O0FBQ0EsVUFBSSxLQUFLdEUsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBN0IsRUFBdUM7QUFDckMsZUFBTyxLQUFLVCxJQUFMLENBQVVTLFFBQWpCO0FBQ0Q7QUFDRjtBQUNGLEdBN0RJLENBQVA7QUE4REQsQ0EzRkQ7O0FBNkZBZCxTQUFTLENBQUNxQixTQUFWLENBQW9CNkQscUJBQXBCLEdBQTRDLGdCQUFlQyxRQUFmLEVBQXlCO0FBQ25FO0FBQ0EsTUFDRSxDQUFDckYsUUFBUSxDQUFDNEQsYUFBVCxDQUNDLEtBQUt2RCxTQUROLEVBRUNMLFFBQVEsQ0FBQzZELEtBQVQsQ0FBZXlCLFdBRmhCLEVBR0MsS0FBS25GLE1BQUwsQ0FBWTRELGFBSGIsQ0FESCxFQU1FO0FBQ0E7QUFDRCxHQVZrRSxDQVluRTs7O0FBQ0EsUUFBTUMsU0FBUyxHQUFHO0FBQUUzRCxJQUFBQSxTQUFTLEVBQUUsS0FBS0E7QUFBbEIsR0FBbEI7QUFDQSxRQUFNMEMsSUFBSSxHQUFHL0MsUUFBUSxDQUFDb0UsT0FBVCxDQUFpQkosU0FBakIsRUFBNEJxQixRQUE1QixDQUFiLENBZG1FLENBZ0JuRTs7QUFDQSxRQUFNckYsUUFBUSxDQUFDMkUsZUFBVCxDQUNKM0UsUUFBUSxDQUFDNkQsS0FBVCxDQUFleUIsV0FEWCxFQUVKLEtBQUtsRixJQUZELEVBR0oyQyxJQUhJLEVBSUosSUFKSSxFQUtKLEtBQUs1QyxNQUxELEVBTUosS0FBS1ksT0FORCxDQUFOO0FBUUQsQ0F6QkQ7O0FBMkJBYixTQUFTLENBQUNxQixTQUFWLENBQW9CYSx5QkFBcEIsR0FBZ0QsWUFBVztBQUN6RCxNQUFJLEtBQUs3QixJQUFULEVBQWU7QUFDYjtBQUNBLFNBQUtBLElBQUwsQ0FBVVksU0FBVixHQUFzQixLQUFLQSxTQUEzQjs7QUFDQSxRQUFJLENBQUMsS0FBS2IsS0FBVixFQUFpQjtBQUNmLFdBQUtDLElBQUwsQ0FBVWdGLFNBQVYsR0FBc0IsS0FBS3BFLFNBQTNCLENBRGUsQ0FHZjs7QUFDQSxVQUFJLENBQUMsS0FBS1osSUFBTCxDQUFVUyxRQUFmLEVBQXlCO0FBQ3ZCLGFBQUtULElBQUwsQ0FBVVMsUUFBVixHQUFxQm5CLFdBQVcsQ0FBQzJGLFdBQVosQ0FBd0IsS0FBS3JGLE1BQUwsQ0FBWXNGLFlBQXBDLENBQXJCO0FBQ0Q7QUFDRjtBQUNGOztBQUNELFNBQU9oRSxPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNELENBZEQsQyxDQWdCQTtBQUNBO0FBQ0E7OztBQUNBeEIsU0FBUyxDQUFDcUIsU0FBVixDQUFvQlMsZ0JBQXBCLEdBQXVDLFlBQVc7QUFDaEQsTUFBSSxLQUFLM0IsU0FBTCxLQUFtQixPQUF2QixFQUFnQztBQUM5QjtBQUNEOztBQUVELE1BQUksQ0FBQyxLQUFLQyxLQUFOLElBQWUsQ0FBQyxLQUFLQyxJQUFMLENBQVVtRixRQUE5QixFQUF3QztBQUN0QyxRQUNFLE9BQU8sS0FBS25GLElBQUwsQ0FBVW9GLFFBQWpCLEtBQThCLFFBQTlCLElBQ0FiLGdCQUFFYyxPQUFGLENBQVUsS0FBS3JGLElBQUwsQ0FBVW9GLFFBQXBCLENBRkYsRUFHRTtBQUNBLFlBQU0sSUFBSTVGLEtBQUssQ0FBQ1ksS0FBVixDQUNKWixLQUFLLENBQUNZLEtBQU4sQ0FBWWtGLGdCQURSLEVBRUoseUJBRkksQ0FBTjtBQUlEOztBQUNELFFBQ0UsT0FBTyxLQUFLdEYsSUFBTCxDQUFVdUYsUUFBakIsS0FBOEIsUUFBOUIsSUFDQWhCLGdCQUFFYyxPQUFGLENBQVUsS0FBS3JGLElBQUwsQ0FBVXVGLFFBQXBCLENBRkYsRUFHRTtBQUNBLFlBQU0sSUFBSS9GLEtBQUssQ0FBQ1ksS0FBVixDQUNKWixLQUFLLENBQUNZLEtBQU4sQ0FBWW9GLGdCQURSLEVBRUosc0JBRkksQ0FBTjtBQUlEO0FBQ0Y7O0FBRUQsTUFBSSxDQUFDLEtBQUt4RixJQUFMLENBQVVtRixRQUFYLElBQXVCLENBQUNNLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZLEtBQUsxRixJQUFMLENBQVVtRixRQUF0QixFQUFnQ2pCLE1BQTVELEVBQW9FO0FBQ2xFO0FBQ0Q7O0FBRUQsTUFBSWlCLFFBQVEsR0FBRyxLQUFLbkYsSUFBTCxDQUFVbUYsUUFBekI7QUFDQSxNQUFJUSxTQUFTLEdBQUdGLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZUCxRQUFaLENBQWhCOztBQUNBLE1BQUlRLFNBQVMsQ0FBQ3pCLE1BQVYsR0FBbUIsQ0FBdkIsRUFBMEI7QUFDeEIsVUFBTTBCLGlCQUFpQixHQUFHRCxTQUFTLENBQUNuQixNQUFWLENBQWlCLENBQUNxQixTQUFELEVBQVlDLFFBQVosS0FBeUI7QUFDbEUsVUFBSUMsZ0JBQWdCLEdBQUdaLFFBQVEsQ0FBQ1csUUFBRCxDQUEvQjtBQUNBLFVBQUlFLFFBQVEsR0FBR0QsZ0JBQWdCLElBQUlBLGdCQUFnQixDQUFDbkQsRUFBcEQ7QUFDQSxhQUFPaUQsU0FBUyxLQUFLRyxRQUFRLElBQUlELGdCQUFnQixJQUFJLElBQXJDLENBQWhCO0FBQ0QsS0FKeUIsRUFJdkIsSUFKdUIsQ0FBMUI7O0FBS0EsUUFBSUgsaUJBQUosRUFBdUI7QUFDckIsYUFBTyxLQUFLSyxjQUFMLENBQW9CZCxRQUFwQixDQUFQO0FBQ0Q7QUFDRjs7QUFDRCxRQUFNLElBQUkzRixLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVk4RixtQkFEUixFQUVKLDRDQUZJLENBQU47QUFJRCxDQTlDRDs7QUFnREF2RyxTQUFTLENBQUNxQixTQUFWLENBQW9CbUYsd0JBQXBCLEdBQStDLFVBQVNoQixRQUFULEVBQW1CO0FBQ2hFLFFBQU1pQixXQUFXLEdBQUdYLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZUCxRQUFaLEVBQXNCa0IsR0FBdEIsQ0FBMEJQLFFBQVEsSUFBSTtBQUN4RCxRQUFJWCxRQUFRLENBQUNXLFFBQUQsQ0FBUixLQUF1QixJQUEzQixFQUFpQztBQUMvQixhQUFPNUUsT0FBTyxDQUFDQyxPQUFSLEVBQVA7QUFDRDs7QUFDRCxVQUFNTSxnQkFBZ0IsR0FBRyxLQUFLN0IsTUFBTCxDQUFZMEcsZUFBWixDQUE0QkMsdUJBQTVCLENBQ3ZCVCxRQUR1QixDQUF6Qjs7QUFHQSxRQUFJLENBQUNyRSxnQkFBTCxFQUF1QjtBQUNyQixZQUFNLElBQUlqQyxLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVk4RixtQkFEUixFQUVKLDRDQUZJLENBQU47QUFJRDs7QUFDRCxXQUFPekUsZ0JBQWdCLENBQUMwRCxRQUFRLENBQUNXLFFBQUQsQ0FBVCxDQUF2QjtBQUNELEdBZG1CLENBQXBCO0FBZUEsU0FBTzVFLE9BQU8sQ0FBQ3NGLEdBQVIsQ0FBWUosV0FBWixDQUFQO0FBQ0QsQ0FqQkQ7O0FBbUJBekcsU0FBUyxDQUFDcUIsU0FBVixDQUFvQnlGLHFCQUFwQixHQUE0QyxVQUFTdEIsUUFBVCxFQUFtQjtBQUM3RCxRQUFNUSxTQUFTLEdBQUdGLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZUCxRQUFaLENBQWxCO0FBQ0EsUUFBTXBGLEtBQUssR0FBRzRGLFNBQVMsQ0FDcEJuQixNQURXLENBQ0osQ0FBQ2tDLElBQUQsRUFBT1osUUFBUCxLQUFvQjtBQUMxQixRQUFJLENBQUNYLFFBQVEsQ0FBQ1csUUFBRCxDQUFiLEVBQXlCO0FBQ3ZCLGFBQU9ZLElBQVA7QUFDRDs7QUFDRCxVQUFNQyxRQUFRLEdBQUksWUFBV2IsUUFBUyxLQUF0QztBQUNBLFVBQU0vRixLQUFLLEdBQUcsRUFBZDtBQUNBQSxJQUFBQSxLQUFLLENBQUM0RyxRQUFELENBQUwsR0FBa0J4QixRQUFRLENBQUNXLFFBQUQsQ0FBUixDQUFtQmxELEVBQXJDO0FBQ0E4RCxJQUFBQSxJQUFJLENBQUM5QixJQUFMLENBQVU3RSxLQUFWO0FBQ0EsV0FBTzJHLElBQVA7QUFDRCxHQVZXLEVBVVQsRUFWUyxFQVdYRSxNQVhXLENBV0pDLENBQUMsSUFBSTtBQUNYLFdBQU8sT0FBT0EsQ0FBUCxLQUFhLFdBQXBCO0FBQ0QsR0FiVyxDQUFkO0FBZUEsTUFBSUMsV0FBVyxHQUFHNUYsT0FBTyxDQUFDQyxPQUFSLENBQWdCLEVBQWhCLENBQWxCOztBQUNBLE1BQUlwQixLQUFLLENBQUNtRSxNQUFOLEdBQWUsQ0FBbkIsRUFBc0I7QUFDcEI0QyxJQUFBQSxXQUFXLEdBQUcsS0FBS2xILE1BQUwsQ0FBWW9ELFFBQVosQ0FBcUIrRCxJQUFyQixDQUEwQixLQUFLakgsU0FBL0IsRUFBMEM7QUFBRWtILE1BQUFBLEdBQUcsRUFBRWpIO0FBQVAsS0FBMUMsRUFBMEQsRUFBMUQsQ0FBZDtBQUNEOztBQUVELFNBQU8rRyxXQUFQO0FBQ0QsQ0F2QkQ7O0FBeUJBbkgsU0FBUyxDQUFDcUIsU0FBVixDQUFvQmlHLG9CQUFwQixHQUEyQyxVQUFTQyxPQUFULEVBQWtCO0FBQzNELE1BQUksS0FBS3JILElBQUwsQ0FBVXlDLFFBQWQsRUFBd0I7QUFDdEIsV0FBTzRFLE9BQVA7QUFDRDs7QUFDRCxTQUFPQSxPQUFPLENBQUNOLE1BQVIsQ0FBZXZDLE1BQU0sSUFBSTtBQUM5QixRQUFJLENBQUNBLE1BQU0sQ0FBQzhDLEdBQVosRUFBaUI7QUFDZixhQUFPLElBQVAsQ0FEZSxDQUNGO0FBQ2QsS0FINkIsQ0FJOUI7OztBQUNBLFdBQU85QyxNQUFNLENBQUM4QyxHQUFQLElBQWMxQixNQUFNLENBQUNDLElBQVAsQ0FBWXJCLE1BQU0sQ0FBQzhDLEdBQW5CLEVBQXdCakQsTUFBeEIsR0FBaUMsQ0FBdEQ7QUFDRCxHQU5NLENBQVA7QUFPRCxDQVhEOztBQWFBdkUsU0FBUyxDQUFDcUIsU0FBVixDQUFvQmlGLGNBQXBCLEdBQXFDLFVBQVNkLFFBQVQsRUFBbUI7QUFDdEQsTUFBSWlDLE9BQUo7QUFDQSxTQUFPLEtBQUtYLHFCQUFMLENBQTJCdEIsUUFBM0IsRUFBcUMvRCxJQUFyQyxDQUEwQyxNQUFNaUcsQ0FBTixJQUFXO0FBQzFERCxJQUFBQSxPQUFPLEdBQUcsS0FBS0gsb0JBQUwsQ0FBMEJJLENBQTFCLENBQVY7O0FBQ0EsUUFBSUQsT0FBTyxDQUFDbEQsTUFBUixHQUFpQixDQUFyQixFQUF3QjtBQUN0QjtBQUNBLFlBQU0sSUFBSTFFLEtBQUssQ0FBQ1ksS0FBVixDQUNKWixLQUFLLENBQUNZLEtBQU4sQ0FBWWtILHNCQURSLEVBRUosMkJBRkksQ0FBTjtBQUlEOztBQUVELFNBQUtoSCxPQUFMLENBQWEsY0FBYixJQUErQm1GLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZUCxRQUFaLEVBQXNCb0MsSUFBdEIsQ0FBMkIsR0FBM0IsQ0FBL0I7O0FBRUEsUUFBSUgsT0FBTyxDQUFDbEQsTUFBUixHQUFpQixDQUFyQixFQUF3QjtBQUN0QixZQUFNc0QsVUFBVSxHQUFHSixPQUFPLENBQUMsQ0FBRCxDQUExQjtBQUNBLFlBQU1LLGVBQWUsR0FBRyxFQUF4QjtBQUNBaEMsTUFBQUEsTUFBTSxDQUFDQyxJQUFQLENBQVlQLFFBQVosRUFBc0J1QyxPQUF0QixDQUE4QjVCLFFBQVEsSUFBSTtBQUN4QyxjQUFNNkIsWUFBWSxHQUFHeEMsUUFBUSxDQUFDVyxRQUFELENBQTdCO0FBQ0EsY0FBTThCLFlBQVksR0FBR0osVUFBVSxDQUFDckMsUUFBWCxDQUFvQlcsUUFBcEIsQ0FBckI7O0FBQ0EsWUFBSSxDQUFDdkIsZ0JBQUVJLE9BQUYsQ0FBVWdELFlBQVYsRUFBd0JDLFlBQXhCLENBQUwsRUFBNEM7QUFDMUNILFVBQUFBLGVBQWUsQ0FBQzNCLFFBQUQsQ0FBZixHQUE0QjZCLFlBQTVCO0FBQ0Q7QUFDRixPQU5EO0FBT0EsWUFBTUUsa0JBQWtCLEdBQUdwQyxNQUFNLENBQUNDLElBQVAsQ0FBWStCLGVBQVosRUFBNkJ2RCxNQUE3QixLQUF3QyxDQUFuRTtBQUNBLFVBQUk0RCxNQUFKOztBQUNBLFVBQUksS0FBSy9ILEtBQUwsSUFBYyxLQUFLQSxLQUFMLENBQVdVLFFBQTdCLEVBQXVDO0FBQ3JDcUgsUUFBQUEsTUFBTSxHQUFHLEtBQUsvSCxLQUFMLENBQVdVLFFBQXBCO0FBQ0QsT0FGRCxNQUVPLElBQUksS0FBS1osSUFBTCxJQUFhLEtBQUtBLElBQUwsQ0FBVTJDLElBQXZCLElBQStCLEtBQUszQyxJQUFMLENBQVUyQyxJQUFWLENBQWVJLEVBQWxELEVBQXNEO0FBQzNEa0YsUUFBQUEsTUFBTSxHQUFHLEtBQUtqSSxJQUFMLENBQVUyQyxJQUFWLENBQWVJLEVBQXhCO0FBQ0Q7O0FBQ0QsVUFBSSxDQUFDa0YsTUFBRCxJQUFXQSxNQUFNLEtBQUtOLFVBQVUsQ0FBQy9HLFFBQXJDLEVBQStDO0FBQzdDO0FBQ0E7QUFDQTtBQUNBLGVBQU8yRyxPQUFPLENBQUMsQ0FBRCxDQUFQLENBQVc3QixRQUFsQixDQUo2QyxDQU03Qzs7QUFDQSxhQUFLdkYsSUFBTCxDQUFVUyxRQUFWLEdBQXFCK0csVUFBVSxDQUFDL0csUUFBaEM7O0FBRUEsWUFBSSxDQUFDLEtBQUtWLEtBQU4sSUFBZSxDQUFDLEtBQUtBLEtBQUwsQ0FBV1UsUUFBL0IsRUFBeUM7QUFDdkM7QUFDQSxlQUFLRSxRQUFMLEdBQWdCO0FBQ2RBLFlBQUFBLFFBQVEsRUFBRTZHLFVBREk7QUFFZE8sWUFBQUEsUUFBUSxFQUFFLEtBQUtBLFFBQUw7QUFGSSxXQUFoQixDQUZ1QyxDQU12QztBQUNBO0FBQ0E7O0FBQ0EsZ0JBQU0sS0FBS2xELHFCQUFMLENBQTJCekYsUUFBUSxDQUFDb0ksVUFBRCxDQUFuQyxDQUFOO0FBQ0QsU0FuQjRDLENBcUI3Qzs7O0FBQ0EsWUFBSSxDQUFDSyxrQkFBTCxFQUF5QjtBQUN2QjtBQUNELFNBeEI0QyxDQXlCN0M7QUFDQTtBQUNBO0FBQ0E7OztBQUNBLGVBQU8sS0FBSzFCLHdCQUFMLENBQThCc0IsZUFBOUIsRUFBK0NyRyxJQUEvQyxDQUFvRCxZQUFZO0FBQ3JFO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsY0FBSSxLQUFLVCxRQUFULEVBQW1CO0FBQ2pCO0FBQ0E4RSxZQUFBQSxNQUFNLENBQUNDLElBQVAsQ0FBWStCLGVBQVosRUFBNkJDLE9BQTdCLENBQXFDNUIsUUFBUSxJQUFJO0FBQy9DLG1CQUFLbkYsUUFBTCxDQUFjQSxRQUFkLENBQXVCd0UsUUFBdkIsQ0FBZ0NXLFFBQWhDLElBQ0UyQixlQUFlLENBQUMzQixRQUFELENBRGpCO0FBRUQsYUFIRCxFQUZpQixDQU9qQjtBQUNBO0FBQ0E7O0FBQ0EsbUJBQU8sS0FBS2xHLE1BQUwsQ0FBWW9ELFFBQVosQ0FBcUJlLE1BQXJCLENBQ0wsS0FBS2pFLFNBREEsRUFFTDtBQUFFVyxjQUFBQSxRQUFRLEVBQUUsS0FBS1QsSUFBTCxDQUFVUztBQUF0QixhQUZLLEVBR0w7QUFBRTBFLGNBQUFBLFFBQVEsRUFBRXNDO0FBQVosYUFISyxFQUlMLEVBSkssQ0FBUDtBQU1EO0FBQ0YsU0F0Qk0sQ0FBUDtBQXVCRCxPQXBERCxNQW9ETyxJQUFJSyxNQUFKLEVBQVk7QUFDakI7QUFDQTtBQUNBLFlBQUlOLFVBQVUsQ0FBQy9HLFFBQVgsS0FBd0JxSCxNQUE1QixFQUFvQztBQUNsQyxnQkFBTSxJQUFJdEksS0FBSyxDQUFDWSxLQUFWLENBQ0paLEtBQUssQ0FBQ1ksS0FBTixDQUFZa0gsc0JBRFIsRUFFSiwyQkFGSSxDQUFOO0FBSUQsU0FSZ0IsQ0FTakI7OztBQUNBLFlBQUksQ0FBQ08sa0JBQUwsRUFBeUI7QUFDdkI7QUFDRDtBQUNGO0FBQ0Y7O0FBQ0QsV0FBTyxLQUFLMUIsd0JBQUwsQ0FBOEJoQixRQUE5QixDQUFQO0FBQ0QsR0FqR00sQ0FBUDtBQWtHRCxDQXBHRCxDLENBc0dBOzs7QUFDQXhGLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JjLGFBQXBCLEdBQW9DLFlBQVc7QUFDN0MsTUFBSWtHLE9BQU8sR0FBRzlHLE9BQU8sQ0FBQ0MsT0FBUixFQUFkOztBQUVBLE1BQUksS0FBS3JCLFNBQUwsS0FBbUIsT0FBdkIsRUFBZ0M7QUFDOUIsV0FBT2tJLE9BQVA7QUFDRDs7QUFFRCxNQUFJLENBQUMsS0FBS25JLElBQUwsQ0FBVXlDLFFBQVgsSUFBdUIsbUJBQW1CLEtBQUt0QyxJQUFuRCxFQUF5RDtBQUN2RCxVQUFNaUksS0FBSyxHQUFJLCtEQUFmO0FBQ0EsVUFBTSxJQUFJekksS0FBSyxDQUFDWSxLQUFWLENBQWdCWixLQUFLLENBQUNZLEtBQU4sQ0FBWUMsbUJBQTVCLEVBQWlENEgsS0FBakQsQ0FBTjtBQUNELEdBVjRDLENBWTdDOzs7QUFDQSxNQUFJLEtBQUtsSSxLQUFMLElBQWMsS0FBS1UsUUFBTCxFQUFsQixFQUFtQztBQUNqQztBQUNBO0FBQ0F1SCxJQUFBQSxPQUFPLEdBQUcsSUFBSUUsa0JBQUosQ0FBYyxLQUFLdEksTUFBbkIsRUFBMkJQLElBQUksQ0FBQzhJLE1BQUwsQ0FBWSxLQUFLdkksTUFBakIsQ0FBM0IsRUFBcUQsVUFBckQsRUFBaUU7QUFDekU0QyxNQUFBQSxJQUFJLEVBQUU7QUFDSjRGLFFBQUFBLE1BQU0sRUFBRSxTQURKO0FBRUp0SSxRQUFBQSxTQUFTLEVBQUUsT0FGUDtBQUdKVyxRQUFBQSxRQUFRLEVBQUUsS0FBS0EsUUFBTDtBQUhOO0FBRG1FLEtBQWpFLEVBT1BRLE9BUE8sR0FRUEcsSUFSTyxDQVFGZ0csT0FBTyxJQUFJO0FBQ2ZBLE1BQUFBLE9BQU8sQ0FBQ0EsT0FBUixDQUFnQk0sT0FBaEIsQ0FBd0JXLE9BQU8sSUFDN0IsS0FBS3pJLE1BQUwsQ0FBWTBJLGVBQVosQ0FBNEI5RixJQUE1QixDQUFpQytGLEdBQWpDLENBQXFDRixPQUFPLENBQUNHLFlBQTdDLENBREY7QUFHRCxLQVpPLENBQVY7QUFhRDs7QUFFRCxTQUFPUixPQUFPLENBQ1g1RyxJQURJLENBQ0MsTUFBTTtBQUNWO0FBQ0EsUUFBSSxLQUFLcEIsSUFBTCxDQUFVdUYsUUFBVixLQUF1QmtELFNBQTNCLEVBQXNDO0FBQ3BDO0FBQ0EsYUFBT3ZILE9BQU8sQ0FBQ0MsT0FBUixFQUFQO0FBQ0Q7O0FBRUQsUUFBSSxLQUFLcEIsS0FBVCxFQUFnQjtBQUNkLFdBQUtPLE9BQUwsQ0FBYSxlQUFiLElBQWdDLElBQWhDLENBRGMsQ0FFZDs7QUFDQSxVQUFJLENBQUMsS0FBS1QsSUFBTCxDQUFVeUMsUUFBZixFQUF5QjtBQUN2QixhQUFLaEMsT0FBTCxDQUFhLG9CQUFiLElBQXFDLElBQXJDO0FBQ0Q7QUFDRjs7QUFFRCxXQUFPLEtBQUtvSSx1QkFBTCxHQUErQnRILElBQS9CLENBQW9DLE1BQU07QUFDL0MsYUFBTzdCLGNBQWMsQ0FBQ29KLElBQWYsQ0FBb0IsS0FBSzNJLElBQUwsQ0FBVXVGLFFBQTlCLEVBQXdDbkUsSUFBeEMsQ0FBNkN3SCxjQUFjLElBQUk7QUFDcEUsYUFBSzVJLElBQUwsQ0FBVTZJLGdCQUFWLEdBQTZCRCxjQUE3QjtBQUNBLGVBQU8sS0FBSzVJLElBQUwsQ0FBVXVGLFFBQWpCO0FBQ0QsT0FITSxDQUFQO0FBSUQsS0FMTSxDQUFQO0FBTUQsR0F0QkksRUF1QkpuRSxJQXZCSSxDQXVCQyxNQUFNO0FBQ1YsV0FBTyxLQUFLMEgsaUJBQUwsRUFBUDtBQUNELEdBekJJLEVBMEJKMUgsSUExQkksQ0EwQkMsTUFBTTtBQUNWLFdBQU8sS0FBSzJILGNBQUwsRUFBUDtBQUNELEdBNUJJLENBQVA7QUE2QkQsQ0E1REQ7O0FBOERBcEosU0FBUyxDQUFDcUIsU0FBVixDQUFvQjhILGlCQUFwQixHQUF3QyxZQUFXO0FBQ2pEO0FBQ0EsTUFBSSxDQUFDLEtBQUs5SSxJQUFMLENBQVVvRixRQUFmLEVBQXlCO0FBQ3ZCLFFBQUksQ0FBQyxLQUFLckYsS0FBVixFQUFpQjtBQUNmLFdBQUtDLElBQUwsQ0FBVW9GLFFBQVYsR0FBcUI5RixXQUFXLENBQUMwSixZQUFaLENBQXlCLEVBQXpCLENBQXJCO0FBQ0EsV0FBS0MsMEJBQUwsR0FBa0MsSUFBbEM7QUFDRDs7QUFDRCxXQUFPL0gsT0FBTyxDQUFDQyxPQUFSLEVBQVA7QUFDRCxHQVJnRCxDQVNqRDtBQUNBOzs7QUFDQSxTQUFPLEtBQUt2QixNQUFMLENBQVlvRCxRQUFaLENBQ0orRCxJQURJLENBRUgsS0FBS2pILFNBRkYsRUFHSDtBQUFFc0YsSUFBQUEsUUFBUSxFQUFFLEtBQUtwRixJQUFMLENBQVVvRixRQUF0QjtBQUFnQzNFLElBQUFBLFFBQVEsRUFBRTtBQUFFeUksTUFBQUEsR0FBRyxFQUFFLEtBQUt6SSxRQUFMO0FBQVA7QUFBMUMsR0FIRyxFQUlIO0FBQUUwSSxJQUFBQSxLQUFLLEVBQUU7QUFBVCxHQUpHLEVBTUovSCxJQU5JLENBTUNnRyxPQUFPLElBQUk7QUFDZixRQUFJQSxPQUFPLENBQUNsRCxNQUFSLEdBQWlCLENBQXJCLEVBQXdCO0FBQ3RCLFlBQU0sSUFBSTFFLEtBQUssQ0FBQ1ksS0FBVixDQUNKWixLQUFLLENBQUNZLEtBQU4sQ0FBWWdKLGNBRFIsRUFFSiwyQ0FGSSxDQUFOO0FBSUQ7O0FBQ0Q7QUFDRCxHQWRJLENBQVA7QUFlRCxDQTFCRDs7QUE0QkF6SixTQUFTLENBQUNxQixTQUFWLENBQW9CK0gsY0FBcEIsR0FBcUMsWUFBVztBQUM5QyxNQUFJLENBQUMsS0FBSy9JLElBQUwsQ0FBVXFKLEtBQVgsSUFBb0IsS0FBS3JKLElBQUwsQ0FBVXFKLEtBQVYsQ0FBZ0JDLElBQWhCLEtBQXlCLFFBQWpELEVBQTJEO0FBQ3pELFdBQU9wSSxPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNELEdBSDZDLENBSTlDOzs7QUFDQSxNQUFJLENBQUMsS0FBS25CLElBQUwsQ0FBVXFKLEtBQVYsQ0FBZ0JFLEtBQWhCLENBQXNCLFNBQXRCLENBQUwsRUFBdUM7QUFDckMsV0FBT3JJLE9BQU8sQ0FBQ3NJLE1BQVIsQ0FDTCxJQUFJaEssS0FBSyxDQUFDWSxLQUFWLENBQ0VaLEtBQUssQ0FBQ1ksS0FBTixDQUFZcUoscUJBRGQsRUFFRSxrQ0FGRixDQURLLENBQVA7QUFNRCxHQVo2QyxDQWE5Qzs7O0FBQ0EsU0FBTyxLQUFLN0osTUFBTCxDQUFZb0QsUUFBWixDQUNKK0QsSUFESSxDQUVILEtBQUtqSCxTQUZGLEVBR0g7QUFBRXVKLElBQUFBLEtBQUssRUFBRSxLQUFLckosSUFBTCxDQUFVcUosS0FBbkI7QUFBMEI1SSxJQUFBQSxRQUFRLEVBQUU7QUFBRXlJLE1BQUFBLEdBQUcsRUFBRSxLQUFLekksUUFBTDtBQUFQO0FBQXBDLEdBSEcsRUFJSDtBQUFFMEksSUFBQUEsS0FBSyxFQUFFO0FBQVQsR0FKRyxFQU1KL0gsSUFOSSxDQU1DZ0csT0FBTyxJQUFJO0FBQ2YsUUFBSUEsT0FBTyxDQUFDbEQsTUFBUixHQUFpQixDQUFyQixFQUF3QjtBQUN0QixZQUFNLElBQUkxRSxLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVlzSixXQURSLEVBRUosZ0RBRkksQ0FBTjtBQUlEOztBQUNELFFBQ0UsQ0FBQyxLQUFLMUosSUFBTCxDQUFVbUYsUUFBWCxJQUNBLENBQUNNLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZLEtBQUsxRixJQUFMLENBQVVtRixRQUF0QixFQUFnQ2pCLE1BRGpDLElBRUN1QixNQUFNLENBQUNDLElBQVAsQ0FBWSxLQUFLMUYsSUFBTCxDQUFVbUYsUUFBdEIsRUFBZ0NqQixNQUFoQyxLQUEyQyxDQUEzQyxJQUNDdUIsTUFBTSxDQUFDQyxJQUFQLENBQVksS0FBSzFGLElBQUwsQ0FBVW1GLFFBQXRCLEVBQWdDLENBQWhDLE1BQXVDLFdBSjNDLEVBS0U7QUFDQTtBQUNBLFdBQUs3RSxPQUFMLENBQWEsdUJBQWIsSUFBd0MsSUFBeEM7QUFDQSxXQUFLVixNQUFMLENBQVkrSixjQUFaLENBQTJCQyxtQkFBM0IsQ0FBK0MsS0FBSzVKLElBQXBEO0FBQ0Q7QUFDRixHQXZCSSxDQUFQO0FBd0JELENBdENEOztBQXdDQUwsU0FBUyxDQUFDcUIsU0FBVixDQUFvQjBILHVCQUFwQixHQUE4QyxZQUFXO0FBQ3ZELE1BQUksQ0FBQyxLQUFLOUksTUFBTCxDQUFZaUssY0FBakIsRUFBaUMsT0FBTzNJLE9BQU8sQ0FBQ0MsT0FBUixFQUFQO0FBQ2pDLFNBQU8sS0FBSzJJLDZCQUFMLEdBQXFDMUksSUFBckMsQ0FBMEMsTUFBTTtBQUNyRCxXQUFPLEtBQUsySSx3QkFBTCxFQUFQO0FBQ0QsR0FGTSxDQUFQO0FBR0QsQ0FMRDs7QUFPQXBLLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0I4SSw2QkFBcEIsR0FBb0QsWUFBVztBQUM3RDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsUUFBTUUsV0FBVyxHQUFHLEtBQUtwSyxNQUFMLENBQVlpSyxjQUFaLENBQTJCSSxlQUEzQixHQUNoQixLQUFLckssTUFBTCxDQUFZaUssY0FBWixDQUEyQkksZUFEWCxHQUVoQiwwREFGSjtBQUdBLFFBQU1DLHFCQUFxQixHQUFHLHdDQUE5QixDQVo2RCxDQWM3RDs7QUFDQSxNQUNHLEtBQUt0SyxNQUFMLENBQVlpSyxjQUFaLENBQTJCTSxnQkFBM0IsSUFDQyxDQUFDLEtBQUt2SyxNQUFMLENBQVlpSyxjQUFaLENBQTJCTSxnQkFBM0IsQ0FBNEMsS0FBS25LLElBQUwsQ0FBVXVGLFFBQXRELENBREgsSUFFQyxLQUFLM0YsTUFBTCxDQUFZaUssY0FBWixDQUEyQk8saUJBQTNCLElBQ0MsQ0FBQyxLQUFLeEssTUFBTCxDQUFZaUssY0FBWixDQUEyQk8saUJBQTNCLENBQTZDLEtBQUtwSyxJQUFMLENBQVV1RixRQUF2RCxDQUpMLEVBS0U7QUFDQSxXQUFPckUsT0FBTyxDQUFDc0ksTUFBUixDQUNMLElBQUloSyxLQUFLLENBQUNZLEtBQVYsQ0FBZ0JaLEtBQUssQ0FBQ1ksS0FBTixDQUFZaUssZ0JBQTVCLEVBQThDTCxXQUE5QyxDQURLLENBQVA7QUFHRCxHQXhCNEQsQ0EwQjdEOzs7QUFDQSxNQUFJLEtBQUtwSyxNQUFMLENBQVlpSyxjQUFaLENBQTJCUyxrQkFBM0IsS0FBa0QsSUFBdEQsRUFBNEQ7QUFDMUQsUUFBSSxLQUFLdEssSUFBTCxDQUFVb0YsUUFBZCxFQUF3QjtBQUN0QjtBQUNBLFVBQUksS0FBS3BGLElBQUwsQ0FBVXVGLFFBQVYsQ0FBbUJ4QyxPQUFuQixDQUEyQixLQUFLL0MsSUFBTCxDQUFVb0YsUUFBckMsS0FBa0QsQ0FBdEQsRUFDRSxPQUFPbEUsT0FBTyxDQUFDc0ksTUFBUixDQUNMLElBQUloSyxLQUFLLENBQUNZLEtBQVYsQ0FBZ0JaLEtBQUssQ0FBQ1ksS0FBTixDQUFZaUssZ0JBQTVCLEVBQThDSCxxQkFBOUMsQ0FESyxDQUFQO0FBR0gsS0FORCxNQU1PO0FBQ0w7QUFDQSxhQUFPLEtBQUt0SyxNQUFMLENBQVlvRCxRQUFaLENBQ0orRCxJQURJLENBQ0MsT0FERCxFQUNVO0FBQUV0RyxRQUFBQSxRQUFRLEVBQUUsS0FBS0EsUUFBTDtBQUFaLE9BRFYsRUFFSlcsSUFGSSxDQUVDZ0csT0FBTyxJQUFJO0FBQ2YsWUFBSUEsT0FBTyxDQUFDbEQsTUFBUixJQUFrQixDQUF0QixFQUF5QjtBQUN2QixnQkFBTXVFLFNBQU47QUFDRDs7QUFDRCxZQUFJLEtBQUt6SSxJQUFMLENBQVV1RixRQUFWLENBQW1CeEMsT0FBbkIsQ0FBMkJxRSxPQUFPLENBQUMsQ0FBRCxDQUFQLENBQVdoQyxRQUF0QyxLQUFtRCxDQUF2RCxFQUNFLE9BQU9sRSxPQUFPLENBQUNzSSxNQUFSLENBQ0wsSUFBSWhLLEtBQUssQ0FBQ1ksS0FBVixDQUNFWixLQUFLLENBQUNZLEtBQU4sQ0FBWWlLLGdCQURkLEVBRUVILHFCQUZGLENBREssQ0FBUDtBQU1GLGVBQU9oSixPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNELE9BZEksQ0FBUDtBQWVEO0FBQ0Y7O0FBQ0QsU0FBT0QsT0FBTyxDQUFDQyxPQUFSLEVBQVA7QUFDRCxDQXRERDs7QUF3REF4QixTQUFTLENBQUNxQixTQUFWLENBQW9CK0ksd0JBQXBCLEdBQStDLFlBQVc7QUFDeEQ7QUFDQSxNQUFJLEtBQUtoSyxLQUFMLElBQWMsS0FBS0gsTUFBTCxDQUFZaUssY0FBWixDQUEyQlUsa0JBQTdDLEVBQWlFO0FBQy9ELFdBQU8sS0FBSzNLLE1BQUwsQ0FBWW9ELFFBQVosQ0FDSitELElBREksQ0FFSCxPQUZHLEVBR0g7QUFBRXRHLE1BQUFBLFFBQVEsRUFBRSxLQUFLQSxRQUFMO0FBQVosS0FIRyxFQUlIO0FBQUVpRixNQUFBQSxJQUFJLEVBQUUsQ0FBQyxtQkFBRCxFQUFzQixrQkFBdEI7QUFBUixLQUpHLEVBTUp0RSxJQU5JLENBTUNnRyxPQUFPLElBQUk7QUFDZixVQUFJQSxPQUFPLENBQUNsRCxNQUFSLElBQWtCLENBQXRCLEVBQXlCO0FBQ3ZCLGNBQU11RSxTQUFOO0FBQ0Q7O0FBQ0QsWUFBTWpHLElBQUksR0FBRzRFLE9BQU8sQ0FBQyxDQUFELENBQXBCO0FBQ0EsVUFBSW9ELFlBQVksR0FBRyxFQUFuQjtBQUNBLFVBQUloSSxJQUFJLENBQUNpSSxpQkFBVCxFQUNFRCxZQUFZLEdBQUdqRyxnQkFBRW1HLElBQUYsQ0FDYmxJLElBQUksQ0FBQ2lJLGlCQURRLEVBRWIsS0FBSzdLLE1BQUwsQ0FBWWlLLGNBQVosQ0FBMkJVLGtCQUEzQixHQUFnRCxDQUZuQyxDQUFmO0FBSUZDLE1BQUFBLFlBQVksQ0FBQzVGLElBQWIsQ0FBa0JwQyxJQUFJLENBQUMrQyxRQUF2QjtBQUNBLFlBQU1vRixXQUFXLEdBQUcsS0FBSzNLLElBQUwsQ0FBVXVGLFFBQTlCLENBWmUsQ0FhZjs7QUFDQSxZQUFNcUYsUUFBUSxHQUFHSixZQUFZLENBQUNuRSxHQUFiLENBQWlCLFVBQVNzQyxJQUFULEVBQWU7QUFDL0MsZUFBT3BKLGNBQWMsQ0FBQ3NMLE9BQWYsQ0FBdUJGLFdBQXZCLEVBQW9DaEMsSUFBcEMsRUFBMEN2SCxJQUExQyxDQUErQzZDLE1BQU0sSUFBSTtBQUM5RCxjQUFJQSxNQUFKLEVBQ0U7QUFDQSxtQkFBTy9DLE9BQU8sQ0FBQ3NJLE1BQVIsQ0FBZSxpQkFBZixDQUFQO0FBQ0YsaUJBQU90SSxPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNELFNBTE0sQ0FBUDtBQU1ELE9BUGdCLENBQWpCLENBZGUsQ0FzQmY7O0FBQ0EsYUFBT0QsT0FBTyxDQUFDc0YsR0FBUixDQUFZb0UsUUFBWixFQUNKeEosSUFESSxDQUNDLE1BQU07QUFDVixlQUFPRixPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNELE9BSEksRUFJSjJKLEtBSkksQ0FJRUMsR0FBRyxJQUFJO0FBQ1osWUFBSUEsR0FBRyxLQUFLLGlCQUFaLEVBQ0U7QUFDQSxpQkFBTzdKLE9BQU8sQ0FBQ3NJLE1BQVIsQ0FDTCxJQUFJaEssS0FBSyxDQUFDWSxLQUFWLENBQ0VaLEtBQUssQ0FBQ1ksS0FBTixDQUFZaUssZ0JBRGQsRUFFRywrQ0FDQyxLQUFLekssTUFBTCxDQUFZaUssY0FBWixDQUEyQlUsa0JBQzVCLGFBSkgsQ0FESyxDQUFQO0FBUUYsY0FBTVEsR0FBTjtBQUNELE9BaEJJLENBQVA7QUFpQkQsS0E5Q0ksQ0FBUDtBQStDRDs7QUFDRCxTQUFPN0osT0FBTyxDQUFDQyxPQUFSLEVBQVA7QUFDRCxDQXBERDs7QUFzREF4QixTQUFTLENBQUNxQixTQUFWLENBQW9Ca0IsMEJBQXBCLEdBQWlELFlBQVc7QUFDMUQsTUFBSSxLQUFLcEMsU0FBTCxLQUFtQixPQUF2QixFQUFnQztBQUM5QjtBQUNEOztBQUNELE1BQUksS0FBS0MsS0FBVCxFQUFnQjtBQUNkO0FBQ0Q7O0FBQ0QsTUFDRSxDQUFDLEtBQUtPLE9BQUwsQ0FBYSxjQUFiLENBQUQsSUFBaUM7QUFDakMsT0FBS1YsTUFBTCxDQUFZb0wsK0JBRFosSUFDK0M7QUFDL0MsT0FBS3BMLE1BQUwsQ0FBWXFMLGdCQUhkLEVBSUU7QUFDQTtBQUNBLFdBRkEsQ0FFUTtBQUNUOztBQUNELFNBQU8sS0FBS0Msa0JBQUwsRUFBUDtBQUNELENBaEJEOztBQWtCQXZMLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JrSyxrQkFBcEIsR0FBeUMsWUFBVztBQUNsRDtBQUNBO0FBQ0EsTUFBSSxLQUFLckwsSUFBTCxDQUFVc0wsY0FBVixJQUE0QixLQUFLdEwsSUFBTCxDQUFVc0wsY0FBVixLQUE2QixPQUE3RCxFQUFzRTtBQUNwRTtBQUNEOztBQUVELFFBQU07QUFBRUMsSUFBQUEsV0FBRjtBQUFlQyxJQUFBQTtBQUFmLE1BQWlDaE0sSUFBSSxDQUFDZ00sYUFBTCxDQUFtQixLQUFLekwsTUFBeEIsRUFBZ0M7QUFDckVrSSxJQUFBQSxNQUFNLEVBQUUsS0FBS3JILFFBQUwsRUFENkQ7QUFFckU2SyxJQUFBQSxXQUFXLEVBQUU7QUFDWEMsTUFBQUEsTUFBTSxFQUFFLEtBQUtqTCxPQUFMLENBQWEsY0FBYixJQUErQixPQUEvQixHQUF5QyxRQUR0QztBQUVYa0wsTUFBQUEsWUFBWSxFQUFFLEtBQUtsTCxPQUFMLENBQWEsY0FBYixLQUFnQztBQUZuQyxLQUZ3RDtBQU1yRTZLLElBQUFBLGNBQWMsRUFBRSxLQUFLdEwsSUFBTCxDQUFVc0w7QUFOMkMsR0FBaEMsQ0FBdkM7O0FBU0EsTUFBSSxLQUFLeEssUUFBTCxJQUFpQixLQUFLQSxRQUFMLENBQWNBLFFBQW5DLEVBQTZDO0FBQzNDLFNBQUtBLFFBQUwsQ0FBY0EsUUFBZCxDQUF1QjZILFlBQXZCLEdBQXNDNEMsV0FBVyxDQUFDNUMsWUFBbEQ7QUFDRDs7QUFFRCxTQUFPNkMsYUFBYSxFQUFwQjtBQUNELENBckJELEMsQ0F1QkE7OztBQUNBMUwsU0FBUyxDQUFDcUIsU0FBVixDQUFvQlcsNkJBQXBCLEdBQW9ELFlBQVc7QUFDN0QsTUFBSSxLQUFLN0IsU0FBTCxLQUFtQixPQUFuQixJQUE4QixLQUFLQyxLQUFMLEtBQWUsSUFBakQsRUFBdUQ7QUFDckQ7QUFDQTtBQUNEOztBQUVELE1BQUksY0FBYyxLQUFLQyxJQUFuQixJQUEyQixXQUFXLEtBQUtBLElBQS9DLEVBQXFEO0FBQ25ELFVBQU15TCxNQUFNLEdBQUc7QUFDYkMsTUFBQUEsaUJBQWlCLEVBQUU7QUFBRXBDLFFBQUFBLElBQUksRUFBRTtBQUFSLE9BRE47QUFFYnFDLE1BQUFBLDRCQUE0QixFQUFFO0FBQUVyQyxRQUFBQSxJQUFJLEVBQUU7QUFBUjtBQUZqQixLQUFmO0FBSUEsU0FBS3RKLElBQUwsR0FBWXlGLE1BQU0sQ0FBQ21HLE1BQVAsQ0FBYyxLQUFLNUwsSUFBbkIsRUFBeUJ5TCxNQUF6QixDQUFaO0FBQ0Q7QUFDRixDQWJEOztBQWVBOUwsU0FBUyxDQUFDcUIsU0FBVixDQUFvQmdCLHlCQUFwQixHQUFnRCxZQUFXO0FBQ3pEO0FBQ0EsTUFBSSxLQUFLbEMsU0FBTCxJQUFrQixVQUFsQixJQUFnQyxLQUFLQyxLQUF6QyxFQUFnRDtBQUM5QztBQUNELEdBSndELENBS3pEOzs7QUFDQSxRQUFNO0FBQUV5QyxJQUFBQSxJQUFGO0FBQVEySSxJQUFBQSxjQUFSO0FBQXdCM0MsSUFBQUE7QUFBeEIsTUFBeUMsS0FBS3hJLElBQXBEOztBQUNBLE1BQUksQ0FBQ3dDLElBQUQsSUFBUyxDQUFDMkksY0FBZCxFQUE4QjtBQUM1QjtBQUNEOztBQUNELE1BQUksQ0FBQzNJLElBQUksQ0FBQy9CLFFBQVYsRUFBb0I7QUFDbEI7QUFDRDs7QUFDRCxPQUFLYixNQUFMLENBQVlvRCxRQUFaLENBQXFCNkksT0FBckIsQ0FBNkIsVUFBN0IsRUFBeUM7QUFDdkNySixJQUFBQSxJQUR1QztBQUV2QzJJLElBQUFBLGNBRnVDO0FBR3ZDM0MsSUFBQUEsWUFBWSxFQUFFO0FBQUVVLE1BQUFBLEdBQUcsRUFBRVY7QUFBUDtBQUh5QixHQUF6QztBQUtELENBbEJELEMsQ0FvQkE7OztBQUNBN0ksU0FBUyxDQUFDcUIsU0FBVixDQUFvQm1CLGNBQXBCLEdBQXFDLFlBQVc7QUFDOUMsTUFDRSxLQUFLN0IsT0FBTCxJQUNBLEtBQUtBLE9BQUwsQ0FBYSxlQUFiLENBREEsSUFFQSxLQUFLVixNQUFMLENBQVlrTSw0QkFIZCxFQUlFO0FBQ0EsUUFBSUMsWUFBWSxHQUFHO0FBQ2pCdkosTUFBQUEsSUFBSSxFQUFFO0FBQ0o0RixRQUFBQSxNQUFNLEVBQUUsU0FESjtBQUVKdEksUUFBQUEsU0FBUyxFQUFFLE9BRlA7QUFHSlcsUUFBQUEsUUFBUSxFQUFFLEtBQUtBLFFBQUw7QUFITjtBQURXLEtBQW5CO0FBT0EsV0FBTyxLQUFLSCxPQUFMLENBQWEsZUFBYixDQUFQO0FBQ0EsV0FBTyxLQUFLVixNQUFMLENBQVlvRCxRQUFaLENBQ0o2SSxPQURJLENBQ0ksVUFESixFQUNnQkUsWUFEaEIsRUFFSjNLLElBRkksQ0FFQyxLQUFLZSxjQUFMLENBQW9CNkosSUFBcEIsQ0FBeUIsSUFBekIsQ0FGRCxDQUFQO0FBR0Q7O0FBRUQsTUFBSSxLQUFLMUwsT0FBTCxJQUFnQixLQUFLQSxPQUFMLENBQWEsb0JBQWIsQ0FBcEIsRUFBd0Q7QUFDdEQsV0FBTyxLQUFLQSxPQUFMLENBQWEsb0JBQWIsQ0FBUDtBQUNBLFdBQU8sS0FBSzRLLGtCQUFMLEdBQTBCOUosSUFBMUIsQ0FBK0IsS0FBS2UsY0FBTCxDQUFvQjZKLElBQXBCLENBQXlCLElBQXpCLENBQS9CLENBQVA7QUFDRDs7QUFFRCxNQUFJLEtBQUsxTCxPQUFMLElBQWdCLEtBQUtBLE9BQUwsQ0FBYSx1QkFBYixDQUFwQixFQUEyRDtBQUN6RCxXQUFPLEtBQUtBLE9BQUwsQ0FBYSx1QkFBYixDQUFQLENBRHlELENBRXpEOztBQUNBLFNBQUtWLE1BQUwsQ0FBWStKLGNBQVosQ0FBMkJzQyxxQkFBM0IsQ0FBaUQsS0FBS2pNLElBQXREO0FBQ0EsV0FBTyxLQUFLbUMsY0FBTCxDQUFvQjZKLElBQXBCLENBQXlCLElBQXpCLENBQVA7QUFDRDtBQUNGLENBOUJELEMsQ0FnQ0E7QUFDQTs7O0FBQ0FyTSxTQUFTLENBQUNxQixTQUFWLENBQW9CUSxhQUFwQixHQUFvQyxZQUFXO0FBQzdDLE1BQUksS0FBS2IsUUFBTCxJQUFpQixLQUFLYixTQUFMLEtBQW1CLFVBQXhDLEVBQW9EO0FBQ2xEO0FBQ0Q7O0FBRUQsTUFBSSxDQUFDLEtBQUtELElBQUwsQ0FBVTJDLElBQVgsSUFBbUIsQ0FBQyxLQUFLM0MsSUFBTCxDQUFVeUMsUUFBbEMsRUFBNEM7QUFDMUMsVUFBTSxJQUFJOUMsS0FBSyxDQUFDWSxLQUFWLENBQ0paLEtBQUssQ0FBQ1ksS0FBTixDQUFZOEwscUJBRFIsRUFFSix5QkFGSSxDQUFOO0FBSUQsR0FWNEMsQ0FZN0M7OztBQUNBLE1BQUksS0FBS2xNLElBQUwsQ0FBVW1ILEdBQWQsRUFBbUI7QUFDakIsVUFBTSxJQUFJM0gsS0FBSyxDQUFDWSxLQUFWLENBQ0paLEtBQUssQ0FBQ1ksS0FBTixDQUFZTSxnQkFEUixFQUVKLGdCQUFnQixtQkFGWixDQUFOO0FBSUQ7O0FBRUQsTUFBSSxLQUFLWCxLQUFULEVBQWdCO0FBQ2QsUUFDRSxLQUFLQyxJQUFMLENBQVV3QyxJQUFWLElBQ0EsQ0FBQyxLQUFLM0MsSUFBTCxDQUFVeUMsUUFEWCxJQUVBLEtBQUt0QyxJQUFMLENBQVV3QyxJQUFWLENBQWUvQixRQUFmLElBQTJCLEtBQUtaLElBQUwsQ0FBVTJDLElBQVYsQ0FBZUksRUFINUMsRUFJRTtBQUNBLFlBQU0sSUFBSXBELEtBQUssQ0FBQ1ksS0FBVixDQUFnQlosS0FBSyxDQUFDWSxLQUFOLENBQVlNLGdCQUE1QixDQUFOO0FBQ0QsS0FORCxNQU1PLElBQUksS0FBS1YsSUFBTCxDQUFVbUwsY0FBZCxFQUE4QjtBQUNuQyxZQUFNLElBQUkzTCxLQUFLLENBQUNZLEtBQVYsQ0FBZ0JaLEtBQUssQ0FBQ1ksS0FBTixDQUFZTSxnQkFBNUIsQ0FBTjtBQUNELEtBRk0sTUFFQSxJQUFJLEtBQUtWLElBQUwsQ0FBVXdJLFlBQWQsRUFBNEI7QUFDakMsWUFBTSxJQUFJaEosS0FBSyxDQUFDWSxLQUFWLENBQWdCWixLQUFLLENBQUNZLEtBQU4sQ0FBWU0sZ0JBQTVCLENBQU47QUFDRDtBQUNGOztBQUVELE1BQUksQ0FBQyxLQUFLWCxLQUFOLElBQWUsQ0FBQyxLQUFLRixJQUFMLENBQVV5QyxRQUE5QixFQUF3QztBQUN0QyxVQUFNNkoscUJBQXFCLEdBQUcsRUFBOUI7O0FBQ0EsU0FBSyxJQUFJekgsR0FBVCxJQUFnQixLQUFLMUUsSUFBckIsRUFBMkI7QUFDekIsVUFBSTBFLEdBQUcsS0FBSyxVQUFSLElBQXNCQSxHQUFHLEtBQUssTUFBbEMsRUFBMEM7QUFDeEM7QUFDRDs7QUFDRHlILE1BQUFBLHFCQUFxQixDQUFDekgsR0FBRCxDQUFyQixHQUE2QixLQUFLMUUsSUFBTCxDQUFVMEUsR0FBVixDQUE3QjtBQUNEOztBQUVELFVBQU07QUFBRTBHLE1BQUFBLFdBQUY7QUFBZUMsTUFBQUE7QUFBZixRQUFpQ2hNLElBQUksQ0FBQ2dNLGFBQUwsQ0FBbUIsS0FBS3pMLE1BQXhCLEVBQWdDO0FBQ3JFa0ksTUFBQUEsTUFBTSxFQUFFLEtBQUtqSSxJQUFMLENBQVUyQyxJQUFWLENBQWVJLEVBRDhDO0FBRXJFMEksTUFBQUEsV0FBVyxFQUFFO0FBQ1hDLFFBQUFBLE1BQU0sRUFBRTtBQURHLE9BRndEO0FBS3JFWSxNQUFBQTtBQUxxRSxLQUFoQyxDQUF2QztBQVFBLFdBQU9kLGFBQWEsR0FBR2pLLElBQWhCLENBQXFCZ0csT0FBTyxJQUFJO0FBQ3JDLFVBQUksQ0FBQ0EsT0FBTyxDQUFDekcsUUFBYixFQUF1QjtBQUNyQixjQUFNLElBQUluQixLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVlnTSxxQkFEUixFQUVKLHlCQUZJLENBQU47QUFJRDs7QUFDRGhCLE1BQUFBLFdBQVcsQ0FBQyxVQUFELENBQVgsR0FBMEJoRSxPQUFPLENBQUN6RyxRQUFSLENBQWlCLFVBQWpCLENBQTFCO0FBQ0EsV0FBS0EsUUFBTCxHQUFnQjtBQUNkMEwsUUFBQUEsTUFBTSxFQUFFLEdBRE07QUFFZHRFLFFBQUFBLFFBQVEsRUFBRVgsT0FBTyxDQUFDVyxRQUZKO0FBR2RwSCxRQUFBQSxRQUFRLEVBQUV5SztBQUhJLE9BQWhCO0FBS0QsS0FiTSxDQUFQO0FBY0Q7QUFDRixDQWxFRCxDLENBb0VBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBekwsU0FBUyxDQUFDcUIsU0FBVixDQUFvQk8sa0JBQXBCLEdBQXlDLFlBQVc7QUFDbEQsTUFBSSxLQUFLWixRQUFMLElBQWlCLEtBQUtiLFNBQUwsS0FBbUIsZUFBeEMsRUFBeUQ7QUFDdkQ7QUFDRDs7QUFFRCxNQUNFLENBQUMsS0FBS0MsS0FBTixJQUNBLENBQUMsS0FBS0MsSUFBTCxDQUFVc00sV0FEWCxJQUVBLENBQUMsS0FBS3RNLElBQUwsQ0FBVW1MLGNBRlgsSUFHQSxDQUFDLEtBQUt0TCxJQUFMLENBQVVzTCxjQUpiLEVBS0U7QUFDQSxVQUFNLElBQUkzTCxLQUFLLENBQUNZLEtBQVYsQ0FDSixHQURJLEVBRUoseURBQ0UscUNBSEUsQ0FBTjtBQUtELEdBaEJpRCxDQWtCbEQ7QUFDQTs7O0FBQ0EsTUFBSSxLQUFLSixJQUFMLENBQVVzTSxXQUFWLElBQXlCLEtBQUt0TSxJQUFMLENBQVVzTSxXQUFWLENBQXNCcEksTUFBdEIsSUFBZ0MsRUFBN0QsRUFBaUU7QUFDL0QsU0FBS2xFLElBQUwsQ0FBVXNNLFdBQVYsR0FBd0IsS0FBS3RNLElBQUwsQ0FBVXNNLFdBQVYsQ0FBc0JDLFdBQXRCLEVBQXhCO0FBQ0QsR0F0QmlELENBd0JsRDs7O0FBQ0EsTUFBSSxLQUFLdk0sSUFBTCxDQUFVbUwsY0FBZCxFQUE4QjtBQUM1QixTQUFLbkwsSUFBTCxDQUFVbUwsY0FBVixHQUEyQixLQUFLbkwsSUFBTCxDQUFVbUwsY0FBVixDQUF5Qm9CLFdBQXpCLEVBQTNCO0FBQ0Q7O0FBRUQsTUFBSXBCLGNBQWMsR0FBRyxLQUFLbkwsSUFBTCxDQUFVbUwsY0FBL0IsQ0E3QmtELENBK0JsRDs7QUFDQSxNQUFJLENBQUNBLGNBQUQsSUFBbUIsQ0FBQyxLQUFLdEwsSUFBTCxDQUFVeUMsUUFBbEMsRUFBNEM7QUFDMUM2SSxJQUFBQSxjQUFjLEdBQUcsS0FBS3RMLElBQUwsQ0FBVXNMLGNBQTNCO0FBQ0Q7O0FBRUQsTUFBSUEsY0FBSixFQUFvQjtBQUNsQkEsSUFBQUEsY0FBYyxHQUFHQSxjQUFjLENBQUNvQixXQUFmLEVBQWpCO0FBQ0QsR0F0Q2lELENBd0NsRDs7O0FBQ0EsTUFDRSxLQUFLeE0sS0FBTCxJQUNBLENBQUMsS0FBS0MsSUFBTCxDQUFVc00sV0FEWCxJQUVBLENBQUNuQixjQUZELElBR0EsQ0FBQyxLQUFLbkwsSUFBTCxDQUFVd00sVUFKYixFQUtFO0FBQ0E7QUFDRDs7QUFFRCxNQUFJeEUsT0FBTyxHQUFHOUcsT0FBTyxDQUFDQyxPQUFSLEVBQWQ7QUFFQSxNQUFJc0wsT0FBSixDQXBEa0QsQ0FvRHJDOztBQUNiLE1BQUlDLGFBQUo7QUFDQSxNQUFJQyxtQkFBSjtBQUNBLE1BQUlDLGtCQUFrQixHQUFHLEVBQXpCLENBdkRrRCxDQXlEbEQ7O0FBQ0EsUUFBTUMsU0FBUyxHQUFHLEVBQWxCOztBQUNBLE1BQUksS0FBSzlNLEtBQUwsSUFBYyxLQUFLQSxLQUFMLENBQVdVLFFBQTdCLEVBQXVDO0FBQ3JDb00sSUFBQUEsU0FBUyxDQUFDakksSUFBVixDQUFlO0FBQ2JuRSxNQUFBQSxRQUFRLEVBQUUsS0FBS1YsS0FBTCxDQUFXVTtBQURSLEtBQWY7QUFHRDs7QUFDRCxNQUFJMEssY0FBSixFQUFvQjtBQUNsQjBCLElBQUFBLFNBQVMsQ0FBQ2pJLElBQVYsQ0FBZTtBQUNidUcsTUFBQUEsY0FBYyxFQUFFQTtBQURILEtBQWY7QUFHRDs7QUFDRCxNQUFJLEtBQUtuTCxJQUFMLENBQVVzTSxXQUFkLEVBQTJCO0FBQ3pCTyxJQUFBQSxTQUFTLENBQUNqSSxJQUFWLENBQWU7QUFBRTBILE1BQUFBLFdBQVcsRUFBRSxLQUFLdE0sSUFBTCxDQUFVc007QUFBekIsS0FBZjtBQUNEOztBQUVELE1BQUlPLFNBQVMsQ0FBQzNJLE1BQVYsSUFBb0IsQ0FBeEIsRUFBMkI7QUFDekI7QUFDRDs7QUFFRDhELEVBQUFBLE9BQU8sR0FBR0EsT0FBTyxDQUNkNUcsSUFETyxDQUNGLE1BQU07QUFDVixXQUFPLEtBQUt4QixNQUFMLENBQVlvRCxRQUFaLENBQXFCK0QsSUFBckIsQ0FDTCxlQURLLEVBRUw7QUFDRUMsTUFBQUEsR0FBRyxFQUFFNkY7QUFEUCxLQUZLLEVBS0wsRUFMSyxDQUFQO0FBT0QsR0FUTyxFQVVQekwsSUFWTyxDQVVGZ0csT0FBTyxJQUFJO0FBQ2ZBLElBQUFBLE9BQU8sQ0FBQ00sT0FBUixDQUFnQnpELE1BQU0sSUFBSTtBQUN4QixVQUNFLEtBQUtsRSxLQUFMLElBQ0EsS0FBS0EsS0FBTCxDQUFXVSxRQURYLElBRUF3RCxNQUFNLENBQUN4RCxRQUFQLElBQW1CLEtBQUtWLEtBQUwsQ0FBV1UsUUFIaEMsRUFJRTtBQUNBaU0sUUFBQUEsYUFBYSxHQUFHekksTUFBaEI7QUFDRDs7QUFDRCxVQUFJQSxNQUFNLENBQUNrSCxjQUFQLElBQXlCQSxjQUE3QixFQUE2QztBQUMzQ3dCLFFBQUFBLG1CQUFtQixHQUFHMUksTUFBdEI7QUFDRDs7QUFDRCxVQUFJQSxNQUFNLENBQUNxSSxXQUFQLElBQXNCLEtBQUt0TSxJQUFMLENBQVVzTSxXQUFwQyxFQUFpRDtBQUMvQ00sUUFBQUEsa0JBQWtCLENBQUNoSSxJQUFuQixDQUF3QlgsTUFBeEI7QUFDRDtBQUNGLEtBZEQsRUFEZSxDQWlCZjs7QUFDQSxRQUFJLEtBQUtsRSxLQUFMLElBQWMsS0FBS0EsS0FBTCxDQUFXVSxRQUE3QixFQUF1QztBQUNyQyxVQUFJLENBQUNpTSxhQUFMLEVBQW9CO0FBQ2xCLGNBQU0sSUFBSWxOLEtBQUssQ0FBQ1ksS0FBVixDQUNKWixLQUFLLENBQUNZLEtBQU4sQ0FBWStELGdCQURSLEVBRUosOEJBRkksQ0FBTjtBQUlEOztBQUNELFVBQ0UsS0FBS25FLElBQUwsQ0FBVW1MLGNBQVYsSUFDQXVCLGFBQWEsQ0FBQ3ZCLGNBRGQsSUFFQSxLQUFLbkwsSUFBTCxDQUFVbUwsY0FBVixLQUE2QnVCLGFBQWEsQ0FBQ3ZCLGNBSDdDLEVBSUU7QUFDQSxjQUFNLElBQUkzTCxLQUFLLENBQUNZLEtBQVYsQ0FDSixHQURJLEVBRUosK0NBQStDLFdBRjNDLENBQU47QUFJRDs7QUFDRCxVQUNFLEtBQUtKLElBQUwsQ0FBVXNNLFdBQVYsSUFDQUksYUFBYSxDQUFDSixXQURkLElBRUEsS0FBS3RNLElBQUwsQ0FBVXNNLFdBQVYsS0FBMEJJLGFBQWEsQ0FBQ0osV0FGeEMsSUFHQSxDQUFDLEtBQUt0TSxJQUFMLENBQVVtTCxjQUhYLElBSUEsQ0FBQ3VCLGFBQWEsQ0FBQ3ZCLGNBTGpCLEVBTUU7QUFDQSxjQUFNLElBQUkzTCxLQUFLLENBQUNZLEtBQVYsQ0FDSixHQURJLEVBRUosNENBQTRDLFdBRnhDLENBQU47QUFJRDs7QUFDRCxVQUNFLEtBQUtKLElBQUwsQ0FBVXdNLFVBQVYsSUFDQSxLQUFLeE0sSUFBTCxDQUFVd00sVUFEVixJQUVBLEtBQUt4TSxJQUFMLENBQVV3TSxVQUFWLEtBQXlCRSxhQUFhLENBQUNGLFVBSHpDLEVBSUU7QUFDQSxjQUFNLElBQUloTixLQUFLLENBQUNZLEtBQVYsQ0FDSixHQURJLEVBRUosMkNBQTJDLFdBRnZDLENBQU47QUFJRDtBQUNGOztBQUVELFFBQUksS0FBS0wsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBekIsSUFBcUNpTSxhQUF6QyxFQUF3RDtBQUN0REQsTUFBQUEsT0FBTyxHQUFHQyxhQUFWO0FBQ0Q7O0FBRUQsUUFBSXZCLGNBQWMsSUFBSXdCLG1CQUF0QixFQUEyQztBQUN6Q0YsTUFBQUEsT0FBTyxHQUFHRSxtQkFBVjtBQUNELEtBakVjLENBa0VmOzs7QUFDQSxRQUFJLENBQUMsS0FBSzVNLEtBQU4sSUFBZSxDQUFDLEtBQUtDLElBQUwsQ0FBVXdNLFVBQTFCLElBQXdDLENBQUNDLE9BQTdDLEVBQXNEO0FBQ3BELFlBQU0sSUFBSWpOLEtBQUssQ0FBQ1ksS0FBVixDQUNKLEdBREksRUFFSixnREFGSSxDQUFOO0FBSUQ7QUFDRixHQW5GTyxFQW9GUGdCLElBcEZPLENBb0ZGLE1BQU07QUFDVixRQUFJLENBQUNxTCxPQUFMLEVBQWM7QUFDWixVQUFJLENBQUNHLGtCQUFrQixDQUFDMUksTUFBeEIsRUFBZ0M7QUFDOUI7QUFDRCxPQUZELE1BRU8sSUFDTDBJLGtCQUFrQixDQUFDMUksTUFBbkIsSUFBNkIsQ0FBN0IsS0FDQyxDQUFDMEksa0JBQWtCLENBQUMsQ0FBRCxDQUFsQixDQUFzQixnQkFBdEIsQ0FBRCxJQUE0QyxDQUFDekIsY0FEOUMsQ0FESyxFQUdMO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsZUFBT3lCLGtCQUFrQixDQUFDLENBQUQsQ0FBbEIsQ0FBc0IsVUFBdEIsQ0FBUDtBQUNELE9BUk0sTUFRQSxJQUFJLENBQUMsS0FBSzVNLElBQUwsQ0FBVW1MLGNBQWYsRUFBK0I7QUFDcEMsY0FBTSxJQUFJM0wsS0FBSyxDQUFDWSxLQUFWLENBQ0osR0FESSxFQUVKLGtEQUNFLHVDQUhFLENBQU47QUFLRCxPQU5NLE1BTUE7QUFDTDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsWUFBSTBNLFFBQVEsR0FBRztBQUNiUixVQUFBQSxXQUFXLEVBQUUsS0FBS3RNLElBQUwsQ0FBVXNNLFdBRFY7QUFFYm5CLFVBQUFBLGNBQWMsRUFBRTtBQUNkakMsWUFBQUEsR0FBRyxFQUFFaUM7QUFEUztBQUZILFNBQWY7O0FBTUEsWUFBSSxLQUFLbkwsSUFBTCxDQUFVK00sYUFBZCxFQUE2QjtBQUMzQkQsVUFBQUEsUUFBUSxDQUFDLGVBQUQsQ0FBUixHQUE0QixLQUFLOU0sSUFBTCxDQUFVK00sYUFBdEM7QUFDRDs7QUFDRCxhQUFLbk4sTUFBTCxDQUFZb0QsUUFBWixDQUFxQjZJLE9BQXJCLENBQTZCLGVBQTdCLEVBQThDaUIsUUFBOUMsRUFBd0RoQyxLQUF4RCxDQUE4REMsR0FBRyxJQUFJO0FBQ25FLGNBQUlBLEdBQUcsQ0FBQ2lDLElBQUosSUFBWXhOLEtBQUssQ0FBQ1ksS0FBTixDQUFZK0QsZ0JBQTVCLEVBQThDO0FBQzVDO0FBQ0E7QUFDRCxXQUprRSxDQUtuRTs7O0FBQ0EsZ0JBQU00RyxHQUFOO0FBQ0QsU0FQRDtBQVFBO0FBQ0Q7QUFDRixLQTFDRCxNQTBDTztBQUNMLFVBQ0U2QixrQkFBa0IsQ0FBQzFJLE1BQW5CLElBQTZCLENBQTdCLElBQ0EsQ0FBQzBJLGtCQUFrQixDQUFDLENBQUQsQ0FBbEIsQ0FBc0IsZ0JBQXRCLENBRkgsRUFHRTtBQUNBO0FBQ0E7QUFDQTtBQUNBLGNBQU1FLFFBQVEsR0FBRztBQUFFck0sVUFBQUEsUUFBUSxFQUFFZ00sT0FBTyxDQUFDaE07QUFBcEIsU0FBakI7QUFDQSxlQUFPLEtBQUtiLE1BQUwsQ0FBWW9ELFFBQVosQ0FDSjZJLE9BREksQ0FDSSxlQURKLEVBQ3FCaUIsUUFEckIsRUFFSjFMLElBRkksQ0FFQyxNQUFNO0FBQ1YsaUJBQU93TCxrQkFBa0IsQ0FBQyxDQUFELENBQWxCLENBQXNCLFVBQXRCLENBQVA7QUFDRCxTQUpJLEVBS0o5QixLQUxJLENBS0VDLEdBQUcsSUFBSTtBQUNaLGNBQUlBLEdBQUcsQ0FBQ2lDLElBQUosSUFBWXhOLEtBQUssQ0FBQ1ksS0FBTixDQUFZK0QsZ0JBQTVCLEVBQThDO0FBQzVDO0FBQ0E7QUFDRCxXQUpXLENBS1o7OztBQUNBLGdCQUFNNEcsR0FBTjtBQUNELFNBWkksQ0FBUDtBQWFELE9BckJELE1BcUJPO0FBQ0wsWUFDRSxLQUFLL0ssSUFBTCxDQUFVc00sV0FBVixJQUNBRyxPQUFPLENBQUNILFdBQVIsSUFBdUIsS0FBS3RNLElBQUwsQ0FBVXNNLFdBRm5DLEVBR0U7QUFDQTtBQUNBO0FBQ0E7QUFDQSxnQkFBTVEsUUFBUSxHQUFHO0FBQ2ZSLFlBQUFBLFdBQVcsRUFBRSxLQUFLdE0sSUFBTCxDQUFVc007QUFEUixXQUFqQixDQUpBLENBT0E7QUFDQTs7QUFDQSxjQUFJLEtBQUt0TSxJQUFMLENBQVVtTCxjQUFkLEVBQThCO0FBQzVCMkIsWUFBQUEsUUFBUSxDQUFDLGdCQUFELENBQVIsR0FBNkI7QUFDM0I1RCxjQUFBQSxHQUFHLEVBQUUsS0FBS2xKLElBQUwsQ0FBVW1MO0FBRFksYUFBN0I7QUFHRCxXQUpELE1BSU8sSUFDTHNCLE9BQU8sQ0FBQ2hNLFFBQVIsSUFDQSxLQUFLVCxJQUFMLENBQVVTLFFBRFYsSUFFQWdNLE9BQU8sQ0FBQ2hNLFFBQVIsSUFBb0IsS0FBS1QsSUFBTCxDQUFVUyxRQUh6QixFQUlMO0FBQ0E7QUFDQXFNLFlBQUFBLFFBQVEsQ0FBQyxVQUFELENBQVIsR0FBdUI7QUFDckI1RCxjQUFBQSxHQUFHLEVBQUV1RCxPQUFPLENBQUNoTTtBQURRLGFBQXZCO0FBR0QsV0FUTSxNQVNBO0FBQ0w7QUFDQSxtQkFBT2dNLE9BQU8sQ0FBQ2hNLFFBQWY7QUFDRDs7QUFDRCxjQUFJLEtBQUtULElBQUwsQ0FBVStNLGFBQWQsRUFBNkI7QUFDM0JELFlBQUFBLFFBQVEsQ0FBQyxlQUFELENBQVIsR0FBNEIsS0FBSzlNLElBQUwsQ0FBVStNLGFBQXRDO0FBQ0Q7O0FBQ0QsZUFBS25OLE1BQUwsQ0FBWW9ELFFBQVosQ0FDRzZJLE9BREgsQ0FDVyxlQURYLEVBQzRCaUIsUUFENUIsRUFFR2hDLEtBRkgsQ0FFU0MsR0FBRyxJQUFJO0FBQ1osZ0JBQUlBLEdBQUcsQ0FBQ2lDLElBQUosSUFBWXhOLEtBQUssQ0FBQ1ksS0FBTixDQUFZK0QsZ0JBQTVCLEVBQThDO0FBQzVDO0FBQ0E7QUFDRCxhQUpXLENBS1o7OztBQUNBLGtCQUFNNEcsR0FBTjtBQUNELFdBVEg7QUFVRCxTQTNDSSxDQTRDTDs7O0FBQ0EsZUFBTzBCLE9BQU8sQ0FBQ2hNLFFBQWY7QUFDRDtBQUNGO0FBQ0YsR0FyTU8sRUFzTVBXLElBdE1PLENBc01GNkwsS0FBSyxJQUFJO0FBQ2IsUUFBSUEsS0FBSixFQUFXO0FBQ1QsV0FBS2xOLEtBQUwsR0FBYTtBQUFFVSxRQUFBQSxRQUFRLEVBQUV3TTtBQUFaLE9BQWI7QUFDQSxhQUFPLEtBQUtqTixJQUFMLENBQVVTLFFBQWpCO0FBQ0EsYUFBTyxLQUFLVCxJQUFMLENBQVVnRixTQUFqQjtBQUNELEtBTFksQ0FNYjs7QUFDRCxHQTdNTyxDQUFWO0FBOE1BLFNBQU9nRCxPQUFQO0FBQ0QsQ0E1UkQsQyxDQThSQTtBQUNBO0FBQ0E7OztBQUNBckksU0FBUyxDQUFDcUIsU0FBVixDQUFvQmUsNkJBQXBCLEdBQW9ELFlBQVc7QUFDN0Q7QUFDQSxNQUFJLEtBQUtwQixRQUFMLElBQWlCLEtBQUtBLFFBQUwsQ0FBY0EsUUFBbkMsRUFBNkM7QUFDM0MsU0FBS2YsTUFBTCxDQUFZc04sZUFBWixDQUE0QkMsbUJBQTVCLENBQ0UsS0FBS3ZOLE1BRFAsRUFFRSxLQUFLZSxRQUFMLENBQWNBLFFBRmhCO0FBSUQ7QUFDRixDQVJEOztBQVVBaEIsU0FBUyxDQUFDcUIsU0FBVixDQUFvQmlCLG9CQUFwQixHQUEyQyxZQUFXO0FBQ3BELE1BQUksS0FBS3RCLFFBQVQsRUFBbUI7QUFDakI7QUFDRDs7QUFFRCxNQUFJLEtBQUtiLFNBQUwsS0FBbUIsT0FBdkIsRUFBZ0M7QUFDOUIsU0FBS0YsTUFBTCxDQUFZMEksZUFBWixDQUE0QjhFLElBQTVCLENBQWlDQyxLQUFqQztBQUNEOztBQUVELE1BQ0UsS0FBS3ZOLFNBQUwsS0FBbUIsT0FBbkIsSUFDQSxLQUFLQyxLQURMLElBRUEsS0FBS0YsSUFBTCxDQUFVeU4saUJBQVYsRUFIRixFQUlFO0FBQ0EsVUFBTSxJQUFJOU4sS0FBSyxDQUFDWSxLQUFWLENBQ0paLEtBQUssQ0FBQ1ksS0FBTixDQUFZbU4sZUFEUixFQUVILHNCQUFxQixLQUFLeE4sS0FBTCxDQUFXVSxRQUFTLEdBRnRDLENBQU47QUFJRDs7QUFFRCxNQUFJLEtBQUtYLFNBQUwsS0FBbUIsVUFBbkIsSUFBaUMsS0FBS0UsSUFBTCxDQUFVd04sUUFBL0MsRUFBeUQ7QUFDdkQsU0FBS3hOLElBQUwsQ0FBVXlOLFlBQVYsR0FBeUIsS0FBS3pOLElBQUwsQ0FBVXdOLFFBQVYsQ0FBbUJFLElBQTVDO0FBQ0QsR0F0Qm1ELENBd0JwRDtBQUNBOzs7QUFDQSxNQUFJLEtBQUsxTixJQUFMLENBQVVtSCxHQUFWLElBQWlCLEtBQUtuSCxJQUFMLENBQVVtSCxHQUFWLENBQWMsYUFBZCxDQUFyQixFQUFtRDtBQUNqRCxVQUFNLElBQUkzSCxLQUFLLENBQUNZLEtBQVYsQ0FBZ0JaLEtBQUssQ0FBQ1ksS0FBTixDQUFZdU4sV0FBNUIsRUFBeUMsY0FBekMsQ0FBTjtBQUNEOztBQUVELE1BQUksS0FBSzVOLEtBQVQsRUFBZ0I7QUFDZDtBQUNBO0FBQ0EsUUFDRSxLQUFLRCxTQUFMLEtBQW1CLE9BQW5CLElBQ0EsS0FBS0UsSUFBTCxDQUFVbUgsR0FEVixJQUVBLEtBQUt0SCxJQUFMLENBQVV5QyxRQUFWLEtBQXVCLElBSHpCLEVBSUU7QUFDQSxXQUFLdEMsSUFBTCxDQUFVbUgsR0FBVixDQUFjLEtBQUtwSCxLQUFMLENBQVdVLFFBQXpCLElBQXFDO0FBQUVtTixRQUFBQSxJQUFJLEVBQUUsSUFBUjtBQUFjQyxRQUFBQSxLQUFLLEVBQUU7QUFBckIsT0FBckM7QUFDRCxLQVRhLENBVWQ7OztBQUNBLFFBQ0UsS0FBSy9OLFNBQUwsS0FBbUIsT0FBbkIsSUFDQSxLQUFLRSxJQUFMLENBQVU2SSxnQkFEVixJQUVBLEtBQUtqSixNQUFMLENBQVlpSyxjQUZaLElBR0EsS0FBS2pLLE1BQUwsQ0FBWWlLLGNBQVosQ0FBMkJpRSxjQUo3QixFQUtFO0FBQ0EsV0FBSzlOLElBQUwsQ0FBVStOLG9CQUFWLEdBQWlDdk8sS0FBSyxDQUFDcUIsT0FBTixDQUFjLElBQUlDLElBQUosRUFBZCxDQUFqQztBQUNELEtBbEJhLENBbUJkOzs7QUFDQSxXQUFPLEtBQUtkLElBQUwsQ0FBVWdGLFNBQWpCO0FBRUEsUUFBSWdKLEtBQUssR0FBRzlNLE9BQU8sQ0FBQ0MsT0FBUixFQUFaLENBdEJjLENBdUJkOztBQUNBLFFBQ0UsS0FBS3JCLFNBQUwsS0FBbUIsT0FBbkIsSUFDQSxLQUFLRSxJQUFMLENBQVU2SSxnQkFEVixJQUVBLEtBQUtqSixNQUFMLENBQVlpSyxjQUZaLElBR0EsS0FBS2pLLE1BQUwsQ0FBWWlLLGNBQVosQ0FBMkJVLGtCQUo3QixFQUtFO0FBQ0F5RCxNQUFBQSxLQUFLLEdBQUcsS0FBS3BPLE1BQUwsQ0FBWW9ELFFBQVosQ0FDTCtELElBREssQ0FFSixPQUZJLEVBR0o7QUFBRXRHLFFBQUFBLFFBQVEsRUFBRSxLQUFLQSxRQUFMO0FBQVosT0FISSxFQUlKO0FBQUVpRixRQUFBQSxJQUFJLEVBQUUsQ0FBQyxtQkFBRCxFQUFzQixrQkFBdEI7QUFBUixPQUpJLEVBTUx0RSxJQU5LLENBTUFnRyxPQUFPLElBQUk7QUFDZixZQUFJQSxPQUFPLENBQUNsRCxNQUFSLElBQWtCLENBQXRCLEVBQXlCO0FBQ3ZCLGdCQUFNdUUsU0FBTjtBQUNEOztBQUNELGNBQU1qRyxJQUFJLEdBQUc0RSxPQUFPLENBQUMsQ0FBRCxDQUFwQjtBQUNBLFlBQUlvRCxZQUFZLEdBQUcsRUFBbkI7O0FBQ0EsWUFBSWhJLElBQUksQ0FBQ2lJLGlCQUFULEVBQTRCO0FBQzFCRCxVQUFBQSxZQUFZLEdBQUdqRyxnQkFBRW1HLElBQUYsQ0FDYmxJLElBQUksQ0FBQ2lJLGlCQURRLEVBRWIsS0FBSzdLLE1BQUwsQ0FBWWlLLGNBQVosQ0FBMkJVLGtCQUZkLENBQWY7QUFJRCxTQVhjLENBWWY7OztBQUNBLGVBQ0VDLFlBQVksQ0FBQ3RHLE1BQWIsR0FDQStKLElBQUksQ0FBQ0MsR0FBTCxDQUFTLENBQVQsRUFBWSxLQUFLdE8sTUFBTCxDQUFZaUssY0FBWixDQUEyQlUsa0JBQTNCLEdBQWdELENBQTVELENBRkYsRUFHRTtBQUNBQyxVQUFBQSxZQUFZLENBQUMyRCxLQUFiO0FBQ0Q7O0FBQ0QzRCxRQUFBQSxZQUFZLENBQUM1RixJQUFiLENBQWtCcEMsSUFBSSxDQUFDK0MsUUFBdkI7QUFDQSxhQUFLdkYsSUFBTCxDQUFVeUssaUJBQVYsR0FBOEJELFlBQTlCO0FBQ0QsT0EzQkssQ0FBUjtBQTRCRDs7QUFFRCxXQUFPd0QsS0FBSyxDQUFDNU0sSUFBTixDQUFXLE1BQU07QUFDdEI7QUFDQSxhQUFPLEtBQUt4QixNQUFMLENBQVlvRCxRQUFaLENBQ0plLE1BREksQ0FDRyxLQUFLakUsU0FEUixFQUNtQixLQUFLQyxLQUR4QixFQUMrQixLQUFLQyxJQURwQyxFQUMwQyxLQUFLTyxVQUQvQyxFQUVKYSxJQUZJLENBRUNULFFBQVEsSUFBSTtBQUNoQkEsUUFBQUEsUUFBUSxDQUFDQyxTQUFULEdBQXFCLEtBQUtBLFNBQTFCOztBQUNBLGFBQUt3Tix1QkFBTCxDQUE2QnpOLFFBQTdCLEVBQXVDLEtBQUtYLElBQTVDOztBQUNBLGFBQUtXLFFBQUwsR0FBZ0I7QUFBRUEsVUFBQUE7QUFBRixTQUFoQjtBQUNELE9BTkksQ0FBUDtBQU9ELEtBVE0sQ0FBUDtBQVVELEdBdEVELE1Bc0VPO0FBQ0w7QUFDQSxRQUFJLEtBQUtiLFNBQUwsS0FBbUIsT0FBdkIsRUFBZ0M7QUFDOUIsVUFBSXFILEdBQUcsR0FBRyxLQUFLbkgsSUFBTCxDQUFVbUgsR0FBcEIsQ0FEOEIsQ0FFOUI7O0FBQ0EsVUFBSSxDQUFDQSxHQUFMLEVBQVU7QUFDUkEsUUFBQUEsR0FBRyxHQUFHLEVBQU47QUFDQUEsUUFBQUEsR0FBRyxDQUFDLEdBQUQsQ0FBSCxHQUFXO0FBQUV5RyxVQUFBQSxJQUFJLEVBQUUsSUFBUjtBQUFjQyxVQUFBQSxLQUFLLEVBQUU7QUFBckIsU0FBWDtBQUNELE9BTjZCLENBTzlCOzs7QUFDQTFHLE1BQUFBLEdBQUcsQ0FBQyxLQUFLbkgsSUFBTCxDQUFVUyxRQUFYLENBQUgsR0FBMEI7QUFBRW1OLFFBQUFBLElBQUksRUFBRSxJQUFSO0FBQWNDLFFBQUFBLEtBQUssRUFBRTtBQUFyQixPQUExQjtBQUNBLFdBQUs3TixJQUFMLENBQVVtSCxHQUFWLEdBQWdCQSxHQUFoQixDQVQ4QixDQVU5Qjs7QUFDQSxVQUNFLEtBQUt2SCxNQUFMLENBQVlpSyxjQUFaLElBQ0EsS0FBS2pLLE1BQUwsQ0FBWWlLLGNBQVosQ0FBMkJpRSxjQUY3QixFQUdFO0FBQ0EsYUFBSzlOLElBQUwsQ0FBVStOLG9CQUFWLEdBQWlDdk8sS0FBSyxDQUFDcUIsT0FBTixDQUFjLElBQUlDLElBQUosRUFBZCxDQUFqQztBQUNEO0FBQ0YsS0FuQkksQ0FxQkw7OztBQUNBLFdBQU8sS0FBS2xCLE1BQUwsQ0FBWW9ELFFBQVosQ0FDSmdCLE1BREksQ0FDRyxLQUFLbEUsU0FEUixFQUNtQixLQUFLRSxJQUR4QixFQUM4QixLQUFLTyxVQURuQyxFQUVKdUssS0FGSSxDQUVFN0MsS0FBSyxJQUFJO0FBQ2QsVUFDRSxLQUFLbkksU0FBTCxLQUFtQixPQUFuQixJQUNBbUksS0FBSyxDQUFDK0UsSUFBTixLQUFleE4sS0FBSyxDQUFDWSxLQUFOLENBQVlpTyxlQUY3QixFQUdFO0FBQ0EsY0FBTXBHLEtBQU47QUFDRCxPQU5hLENBUWQ7OztBQUNBLFVBQ0VBLEtBQUssSUFDTEEsS0FBSyxDQUFDcUcsUUFETixJQUVBckcsS0FBSyxDQUFDcUcsUUFBTixDQUFlQyxnQkFBZixLQUFvQyxVQUh0QyxFQUlFO0FBQ0EsY0FBTSxJQUFJL08sS0FBSyxDQUFDWSxLQUFWLENBQ0paLEtBQUssQ0FBQ1ksS0FBTixDQUFZZ0osY0FEUixFQUVKLDJDQUZJLENBQU47QUFJRDs7QUFFRCxVQUNFbkIsS0FBSyxJQUNMQSxLQUFLLENBQUNxRyxRQUROLElBRUFyRyxLQUFLLENBQUNxRyxRQUFOLENBQWVDLGdCQUFmLEtBQW9DLE9BSHRDLEVBSUU7QUFDQSxjQUFNLElBQUkvTyxLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVlzSixXQURSLEVBRUosZ0RBRkksQ0FBTjtBQUlELE9BN0JhLENBK0JkO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxhQUFPLEtBQUs5SixNQUFMLENBQVlvRCxRQUFaLENBQ0orRCxJQURJLENBRUgsS0FBS2pILFNBRkYsRUFHSDtBQUNFc0YsUUFBQUEsUUFBUSxFQUFFLEtBQUtwRixJQUFMLENBQVVvRixRQUR0QjtBQUVFM0UsUUFBQUEsUUFBUSxFQUFFO0FBQUV5SSxVQUFBQSxHQUFHLEVBQUUsS0FBS3pJLFFBQUw7QUFBUDtBQUZaLE9BSEcsRUFPSDtBQUFFMEksUUFBQUEsS0FBSyxFQUFFO0FBQVQsT0FQRyxFQVNKL0gsSUFUSSxDQVNDZ0csT0FBTyxJQUFJO0FBQ2YsWUFBSUEsT0FBTyxDQUFDbEQsTUFBUixHQUFpQixDQUFyQixFQUF3QjtBQUN0QixnQkFBTSxJQUFJMUUsS0FBSyxDQUFDWSxLQUFWLENBQ0paLEtBQUssQ0FBQ1ksS0FBTixDQUFZZ0osY0FEUixFQUVKLDJDQUZJLENBQU47QUFJRDs7QUFDRCxlQUFPLEtBQUt4SixNQUFMLENBQVlvRCxRQUFaLENBQXFCK0QsSUFBckIsQ0FDTCxLQUFLakgsU0FEQSxFQUVMO0FBQUV1SixVQUFBQSxLQUFLLEVBQUUsS0FBS3JKLElBQUwsQ0FBVXFKLEtBQW5CO0FBQTBCNUksVUFBQUEsUUFBUSxFQUFFO0FBQUV5SSxZQUFBQSxHQUFHLEVBQUUsS0FBS3pJLFFBQUw7QUFBUDtBQUFwQyxTQUZLLEVBR0w7QUFBRTBJLFVBQUFBLEtBQUssRUFBRTtBQUFULFNBSEssQ0FBUDtBQUtELE9BckJJLEVBc0JKL0gsSUF0QkksQ0FzQkNnRyxPQUFPLElBQUk7QUFDZixZQUFJQSxPQUFPLENBQUNsRCxNQUFSLEdBQWlCLENBQXJCLEVBQXdCO0FBQ3RCLGdCQUFNLElBQUkxRSxLQUFLLENBQUNZLEtBQVYsQ0FDSlosS0FBSyxDQUFDWSxLQUFOLENBQVlzSixXQURSLEVBRUosZ0RBRkksQ0FBTjtBQUlEOztBQUNELGNBQU0sSUFBSWxLLEtBQUssQ0FBQ1ksS0FBVixDQUNKWixLQUFLLENBQUNZLEtBQU4sQ0FBWWlPLGVBRFIsRUFFSiwrREFGSSxDQUFOO0FBSUQsT0FqQ0ksQ0FBUDtBQWtDRCxLQXZFSSxFQXdFSmpOLElBeEVJLENBd0VDVCxRQUFRLElBQUk7QUFDaEJBLE1BQUFBLFFBQVEsQ0FBQ0YsUUFBVCxHQUFvQixLQUFLVCxJQUFMLENBQVVTLFFBQTlCO0FBQ0FFLE1BQUFBLFFBQVEsQ0FBQ3FFLFNBQVQsR0FBcUIsS0FBS2hGLElBQUwsQ0FBVWdGLFNBQS9COztBQUVBLFVBQUksS0FBS2lFLDBCQUFULEVBQXFDO0FBQ25DdEksUUFBQUEsUUFBUSxDQUFDeUUsUUFBVCxHQUFvQixLQUFLcEYsSUFBTCxDQUFVb0YsUUFBOUI7QUFDRDs7QUFDRCxXQUFLZ0osdUJBQUwsQ0FBNkJ6TixRQUE3QixFQUF1QyxLQUFLWCxJQUE1Qzs7QUFDQSxXQUFLVyxRQUFMLEdBQWdCO0FBQ2QwTCxRQUFBQSxNQUFNLEVBQUUsR0FETTtBQUVkMUwsUUFBQUEsUUFGYztBQUdkb0gsUUFBQUEsUUFBUSxFQUFFLEtBQUtBLFFBQUw7QUFISSxPQUFoQjtBQUtELEtBckZJLENBQVA7QUFzRkQ7QUFDRixDQWpORCxDLENBbU5BOzs7QUFDQXBJLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JvQixtQkFBcEIsR0FBMEMsWUFBVztBQUNuRCxNQUFJLENBQUMsS0FBS3pCLFFBQU4sSUFBa0IsQ0FBQyxLQUFLQSxRQUFMLENBQWNBLFFBQXJDLEVBQStDO0FBQzdDO0FBQ0QsR0FIa0QsQ0FLbkQ7OztBQUNBLFFBQU02TixnQkFBZ0IsR0FBRy9PLFFBQVEsQ0FBQzRELGFBQVQsQ0FDdkIsS0FBS3ZELFNBRGtCLEVBRXZCTCxRQUFRLENBQUM2RCxLQUFULENBQWVtTCxTQUZRLEVBR3ZCLEtBQUs3TyxNQUFMLENBQVk0RCxhQUhXLENBQXpCO0FBS0EsUUFBTWtMLFlBQVksR0FBRyxLQUFLOU8sTUFBTCxDQUFZK08sbUJBQVosQ0FBZ0NELFlBQWhDLENBQ25CLEtBQUs1TyxTQURjLENBQXJCOztBQUdBLE1BQUksQ0FBQzBPLGdCQUFELElBQXFCLENBQUNFLFlBQTFCLEVBQXdDO0FBQ3RDLFdBQU94TixPQUFPLENBQUNDLE9BQVIsRUFBUDtBQUNEOztBQUVELE1BQUlzQyxTQUFTLEdBQUc7QUFBRTNELElBQUFBLFNBQVMsRUFBRSxLQUFLQTtBQUFsQixHQUFoQjs7QUFDQSxNQUFJLEtBQUtDLEtBQUwsSUFBYyxLQUFLQSxLQUFMLENBQVdVLFFBQTdCLEVBQXVDO0FBQ3JDZ0QsSUFBQUEsU0FBUyxDQUFDaEQsUUFBVixHQUFxQixLQUFLVixLQUFMLENBQVdVLFFBQWhDO0FBQ0QsR0FyQmtELENBdUJuRDs7O0FBQ0EsTUFBSWlELGNBQUo7O0FBQ0EsTUFBSSxLQUFLM0QsS0FBTCxJQUFjLEtBQUtBLEtBQUwsQ0FBV1UsUUFBN0IsRUFBdUM7QUFDckNpRCxJQUFBQSxjQUFjLEdBQUdqRSxRQUFRLENBQUNvRSxPQUFULENBQWlCSixTQUFqQixFQUE0QixLQUFLeEQsWUFBakMsQ0FBakI7QUFDRCxHQTNCa0QsQ0E2Qm5EO0FBQ0E7OztBQUNBLFFBQU0wRCxhQUFhLEdBQUcsS0FBS0Msa0JBQUwsQ0FBd0JILFNBQXhCLENBQXRCOztBQUNBRSxFQUFBQSxhQUFhLENBQUNpTCxtQkFBZCxDQUNFLEtBQUtqTyxRQUFMLENBQWNBLFFBRGhCLEVBRUUsS0FBS0EsUUFBTCxDQUFjMEwsTUFBZCxJQUF3QixHQUYxQjs7QUFLQSxPQUFLek0sTUFBTCxDQUFZb0QsUUFBWixDQUFxQkMsVUFBckIsR0FBa0M3QixJQUFsQyxDQUF1QzhCLGdCQUFnQixJQUFJO0FBQ3pEO0FBQ0EsVUFBTTJMLEtBQUssR0FBRzNMLGdCQUFnQixDQUFDNEwsd0JBQWpCLENBQ1puTCxhQUFhLENBQUM3RCxTQURGLENBQWQ7QUFHQSxTQUFLRixNQUFMLENBQVkrTyxtQkFBWixDQUFnQ0ksV0FBaEMsQ0FDRXBMLGFBQWEsQ0FBQzdELFNBRGhCLEVBRUU2RCxhQUZGLEVBR0VELGNBSEYsRUFJRW1MLEtBSkY7QUFNRCxHQVhELEVBckNtRCxDQWtEbkQ7O0FBQ0EsU0FBT3BQLFFBQVEsQ0FDWjJFLGVBREksQ0FFSDNFLFFBQVEsQ0FBQzZELEtBQVQsQ0FBZW1MLFNBRlosRUFHSCxLQUFLNU8sSUFIRixFQUlIOEQsYUFKRyxFQUtIRCxjQUxHLEVBTUgsS0FBSzlELE1BTkYsRUFPSCxLQUFLWSxPQVBGLEVBU0pzSyxLQVRJLENBU0UsVUFBU0MsR0FBVCxFQUFjO0FBQ25CaUUsb0JBQU9DLElBQVAsQ0FBWSwyQkFBWixFQUF5Q2xFLEdBQXpDO0FBQ0QsR0FYSSxDQUFQO0FBWUQsQ0EvREQsQyxDQWlFQTs7O0FBQ0FwTCxTQUFTLENBQUNxQixTQUFWLENBQW9CK0csUUFBcEIsR0FBK0IsWUFBVztBQUN4QyxNQUFJbUgsTUFBTSxHQUNSLEtBQUtwUCxTQUFMLEtBQW1CLE9BQW5CLEdBQTZCLFNBQTdCLEdBQXlDLGNBQWMsS0FBS0EsU0FBbkIsR0FBK0IsR0FEMUU7QUFFQSxTQUFPLEtBQUtGLE1BQUwsQ0FBWXVQLEtBQVosR0FBb0JELE1BQXBCLEdBQTZCLEtBQUtsUCxJQUFMLENBQVVTLFFBQTlDO0FBQ0QsQ0FKRCxDLENBTUE7QUFDQTs7O0FBQ0FkLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0JQLFFBQXBCLEdBQStCLFlBQVc7QUFDeEMsU0FBTyxLQUFLVCxJQUFMLENBQVVTLFFBQVYsSUFBc0IsS0FBS1YsS0FBTCxDQUFXVSxRQUF4QztBQUNELENBRkQsQyxDQUlBOzs7QUFDQWQsU0FBUyxDQUFDcUIsU0FBVixDQUFvQm9PLGFBQXBCLEdBQW9DLFlBQVc7QUFDN0MsUUFBTXBQLElBQUksR0FBR3lGLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZLEtBQUsxRixJQUFqQixFQUF1QndFLE1BQXZCLENBQThCLENBQUN4RSxJQUFELEVBQU8wRSxHQUFQLEtBQWU7QUFDeEQ7QUFDQSxRQUFJLENBQUMsMEJBQTBCMkssSUFBMUIsQ0FBK0IzSyxHQUEvQixDQUFMLEVBQTBDO0FBQ3hDLGFBQU8xRSxJQUFJLENBQUMwRSxHQUFELENBQVg7QUFDRDs7QUFDRCxXQUFPMUUsSUFBUDtBQUNELEdBTlksRUFNVlosUUFBUSxDQUFDLEtBQUtZLElBQU4sQ0FORSxDQUFiO0FBT0EsU0FBT1IsS0FBSyxDQUFDOFAsT0FBTixDQUFjN0csU0FBZCxFQUF5QnpJLElBQXpCLENBQVA7QUFDRCxDQVRELEMsQ0FXQTs7O0FBQ0FMLFNBQVMsQ0FBQ3FCLFNBQVYsQ0FBb0I0QyxrQkFBcEIsR0FBeUMsVUFBU0gsU0FBVCxFQUFvQjtBQUMzRCxRQUFNRSxhQUFhLEdBQUdsRSxRQUFRLENBQUNvRSxPQUFULENBQWlCSixTQUFqQixFQUE0QixLQUFLeEQsWUFBakMsQ0FBdEI7QUFDQXdGLEVBQUFBLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZLEtBQUsxRixJQUFqQixFQUF1QndFLE1BQXZCLENBQThCLFVBQVN4RSxJQUFULEVBQWUwRSxHQUFmLEVBQW9CO0FBQ2hELFFBQUlBLEdBQUcsQ0FBQzNCLE9BQUosQ0FBWSxHQUFaLElBQW1CLENBQXZCLEVBQTBCO0FBQ3hCO0FBQ0EsWUFBTXdNLFdBQVcsR0FBRzdLLEdBQUcsQ0FBQzhLLEtBQUosQ0FBVSxHQUFWLENBQXBCO0FBQ0EsWUFBTUMsVUFBVSxHQUFHRixXQUFXLENBQUMsQ0FBRCxDQUE5QjtBQUNBLFVBQUlHLFNBQVMsR0FBRy9MLGFBQWEsQ0FBQ2dNLEdBQWQsQ0FBa0JGLFVBQWxCLENBQWhCOztBQUNBLFVBQUksT0FBT0MsU0FBUCxLQUFxQixRQUF6QixFQUFtQztBQUNqQ0EsUUFBQUEsU0FBUyxHQUFHLEVBQVo7QUFDRDs7QUFDREEsTUFBQUEsU0FBUyxDQUFDSCxXQUFXLENBQUMsQ0FBRCxDQUFaLENBQVQsR0FBNEJ2UCxJQUFJLENBQUMwRSxHQUFELENBQWhDO0FBQ0FmLE1BQUFBLGFBQWEsQ0FBQ2lNLEdBQWQsQ0FBa0JILFVBQWxCLEVBQThCQyxTQUE5QjtBQUNBLGFBQU8xUCxJQUFJLENBQUMwRSxHQUFELENBQVg7QUFDRDs7QUFDRCxXQUFPMUUsSUFBUDtBQUNELEdBZEQsRUFjR1osUUFBUSxDQUFDLEtBQUtZLElBQU4sQ0FkWDtBQWdCQTJELEVBQUFBLGFBQWEsQ0FBQ2lNLEdBQWQsQ0FBa0IsS0FBS1IsYUFBTCxFQUFsQjtBQUNBLFNBQU96TCxhQUFQO0FBQ0QsQ0FwQkQ7O0FBc0JBaEUsU0FBUyxDQUFDcUIsU0FBVixDQUFvQnFCLGlCQUFwQixHQUF3QyxZQUFXO0FBQ2pELE1BQUksS0FBSzFCLFFBQUwsSUFBaUIsS0FBS0EsUUFBTCxDQUFjQSxRQUEvQixJQUEyQyxLQUFLYixTQUFMLEtBQW1CLE9BQWxFLEVBQTJFO0FBQ3pFLFVBQU0wQyxJQUFJLEdBQUcsS0FBSzdCLFFBQUwsQ0FBY0EsUUFBM0I7O0FBQ0EsUUFBSTZCLElBQUksQ0FBQzJDLFFBQVQsRUFBbUI7QUFDakJNLE1BQUFBLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZbEQsSUFBSSxDQUFDMkMsUUFBakIsRUFBMkJ1QyxPQUEzQixDQUFtQzVCLFFBQVEsSUFBSTtBQUM3QyxZQUFJdEQsSUFBSSxDQUFDMkMsUUFBTCxDQUFjVyxRQUFkLE1BQTRCLElBQWhDLEVBQXNDO0FBQ3BDLGlCQUFPdEQsSUFBSSxDQUFDMkMsUUFBTCxDQUFjVyxRQUFkLENBQVA7QUFDRDtBQUNGLE9BSkQ7O0FBS0EsVUFBSUwsTUFBTSxDQUFDQyxJQUFQLENBQVlsRCxJQUFJLENBQUMyQyxRQUFqQixFQUEyQmpCLE1BQTNCLElBQXFDLENBQXpDLEVBQTRDO0FBQzFDLGVBQU8xQixJQUFJLENBQUMyQyxRQUFaO0FBQ0Q7QUFDRjtBQUNGO0FBQ0YsQ0FkRDs7QUFnQkF4RixTQUFTLENBQUNxQixTQUFWLENBQW9Cb04sdUJBQXBCLEdBQThDLFVBQVN6TixRQUFULEVBQW1CWCxJQUFuQixFQUF5QjtBQUNyRSxNQUFJdUUsZ0JBQUVjLE9BQUYsQ0FBVSxLQUFLL0UsT0FBTCxDQUFhZ0Usc0JBQXZCLENBQUosRUFBb0Q7QUFDbEQsV0FBTzNELFFBQVA7QUFDRDs7QUFDRCxRQUFNa1Asb0JBQW9CLEdBQUduUSxTQUFTLENBQUNvUSxxQkFBVixDQUFnQyxLQUFLNVAsU0FBckMsQ0FBN0I7QUFDQSxPQUFLSSxPQUFMLENBQWFnRSxzQkFBYixDQUFvQ29ELE9BQXBDLENBQTRDcUksU0FBUyxJQUFJO0FBQ3ZELFVBQU1DLFNBQVMsR0FBR2hRLElBQUksQ0FBQytQLFNBQUQsQ0FBdEI7O0FBRUEsUUFBSSxDQUFDcFAsUUFBUSxDQUFDc1AsY0FBVCxDQUF3QkYsU0FBeEIsQ0FBTCxFQUF5QztBQUN2Q3BQLE1BQUFBLFFBQVEsQ0FBQ29QLFNBQUQsQ0FBUixHQUFzQkMsU0FBdEI7QUFDRCxLQUxzRCxDQU92RDs7O0FBQ0EsUUFBSXJQLFFBQVEsQ0FBQ29QLFNBQUQsQ0FBUixJQUF1QnBQLFFBQVEsQ0FBQ29QLFNBQUQsQ0FBUixDQUFvQnpHLElBQS9DLEVBQXFEO0FBQ25ELGFBQU8zSSxRQUFRLENBQUNvUCxTQUFELENBQWY7O0FBQ0EsVUFBSUYsb0JBQW9CLElBQUlHLFNBQVMsQ0FBQzFHLElBQVYsSUFBa0IsUUFBOUMsRUFBd0Q7QUFDdEQzSSxRQUFBQSxRQUFRLENBQUNvUCxTQUFELENBQVIsR0FBc0JDLFNBQXRCO0FBQ0Q7QUFDRjtBQUNGLEdBZEQ7QUFlQSxTQUFPclAsUUFBUDtBQUNELENBckJEOztlQXVCZWhCLFM7O0FBQ2Z1USxNQUFNLENBQUNDLE9BQVAsR0FBaUJ4USxTQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIi8vIEEgUmVzdFdyaXRlIGVuY2Fwc3VsYXRlcyBldmVyeXRoaW5nIHdlIG5lZWQgdG8gcnVuIGFuIG9wZXJhdGlvblxuLy8gdGhhdCB3cml0ZXMgdG8gdGhlIGRhdGFiYXNlLlxuLy8gVGhpcyBjb3VsZCBiZSBlaXRoZXIgYSBcImNyZWF0ZVwiIG9yIGFuIFwidXBkYXRlXCIuXG5cbnZhciBTY2hlbWFDb250cm9sbGVyID0gcmVxdWlyZSgnLi9Db250cm9sbGVycy9TY2hlbWFDb250cm9sbGVyJyk7XG52YXIgZGVlcGNvcHkgPSByZXF1aXJlKCdkZWVwY29weScpO1xuXG5jb25zdCBBdXRoID0gcmVxdWlyZSgnLi9BdXRoJyk7XG52YXIgY3J5cHRvVXRpbHMgPSByZXF1aXJlKCcuL2NyeXB0b1V0aWxzJyk7XG52YXIgcGFzc3dvcmRDcnlwdG8gPSByZXF1aXJlKCcuL3Bhc3N3b3JkJyk7XG52YXIgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJyk7XG52YXIgdHJpZ2dlcnMgPSByZXF1aXJlKCcuL3RyaWdnZXJzJyk7XG52YXIgQ2xpZW50U0RLID0gcmVxdWlyZSgnLi9DbGllbnRTREsnKTtcbmltcG9ydCBSZXN0UXVlcnkgZnJvbSAnLi9SZXN0UXVlcnknO1xuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi9sb2dnZXInO1xuXG4vLyBxdWVyeSBhbmQgZGF0YSBhcmUgYm90aCBwcm92aWRlZCBpbiBSRVNUIEFQSSBmb3JtYXQuIFNvIGRhdGFcbi8vIHR5cGVzIGFyZSBlbmNvZGVkIGJ5IHBsYWluIG9sZCBvYmplY3RzLlxuLy8gSWYgcXVlcnkgaXMgbnVsbCwgdGhpcyBpcyBhIFwiY3JlYXRlXCIgYW5kIHRoZSBkYXRhIGluIGRhdGEgc2hvdWxkIGJlXG4vLyBjcmVhdGVkLlxuLy8gT3RoZXJ3aXNlIHRoaXMgaXMgYW4gXCJ1cGRhdGVcIiAtIHRoZSBvYmplY3QgbWF0Y2hpbmcgdGhlIHF1ZXJ5XG4vLyBzaG91bGQgZ2V0IHVwZGF0ZWQgd2l0aCBkYXRhLlxuLy8gUmVzdFdyaXRlIHdpbGwgaGFuZGxlIG9iamVjdElkLCBjcmVhdGVkQXQsIGFuZCB1cGRhdGVkQXQgZm9yXG4vLyBldmVyeXRoaW5nLiBJdCBhbHNvIGtub3dzIHRvIHVzZSB0cmlnZ2VycyBhbmQgc3BlY2lhbCBtb2RpZmljYXRpb25zXG4vLyBmb3IgdGhlIF9Vc2VyIGNsYXNzLlxuZnVuY3Rpb24gUmVzdFdyaXRlKFxuICBjb25maWcsXG4gIGF1dGgsXG4gIGNsYXNzTmFtZSxcbiAgcXVlcnksXG4gIGRhdGEsXG4gIG9yaWdpbmFsRGF0YSxcbiAgY2xpZW50U0RLXG4pIHtcbiAgaWYgKGF1dGguaXNSZWFkT25seSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAnQ2Fubm90IHBlcmZvcm0gYSB3cml0ZSBvcGVyYXRpb24gd2hlbiB1c2luZyByZWFkT25seU1hc3RlcktleSdcbiAgICApO1xuICB9XG4gIHRoaXMuY29uZmlnID0gY29uZmlnO1xuICB0aGlzLmF1dGggPSBhdXRoO1xuICB0aGlzLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgdGhpcy5jbGllbnRTREsgPSBjbGllbnRTREs7XG4gIHRoaXMuc3RvcmFnZSA9IHt9O1xuICB0aGlzLnJ1bk9wdGlvbnMgPSB7fTtcbiAgdGhpcy5jb250ZXh0ID0ge307XG4gIGlmICghcXVlcnkgJiYgZGF0YS5vYmplY3RJZCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAnb2JqZWN0SWQgaXMgYW4gaW52YWxpZCBmaWVsZCBuYW1lLidcbiAgICApO1xuICB9XG5cbiAgLy8gV2hlbiB0aGUgb3BlcmF0aW9uIGlzIGNvbXBsZXRlLCB0aGlzLnJlc3BvbnNlIG1heSBoYXZlIHNldmVyYWxcbiAgLy8gZmllbGRzLlxuICAvLyByZXNwb25zZTogdGhlIGFjdHVhbCBkYXRhIHRvIGJlIHJldHVybmVkXG4gIC8vIHN0YXR1czogdGhlIGh0dHAgc3RhdHVzIGNvZGUuIGlmIG5vdCBwcmVzZW50LCB0cmVhdGVkIGxpa2UgYSAyMDBcbiAgLy8gbG9jYXRpb246IHRoZSBsb2NhdGlvbiBoZWFkZXIuIGlmIG5vdCBwcmVzZW50LCBubyBsb2NhdGlvbiBoZWFkZXJcbiAgdGhpcy5yZXNwb25zZSA9IG51bGw7XG5cbiAgLy8gUHJvY2Vzc2luZyB0aGlzIG9wZXJhdGlvbiBtYXkgbXV0YXRlIG91ciBkYXRhLCBzbyB3ZSBvcGVyYXRlIG9uIGFcbiAgLy8gY29weVxuICB0aGlzLnF1ZXJ5ID0gZGVlcGNvcHkocXVlcnkpO1xuICB0aGlzLmRhdGEgPSBkZWVwY29weShkYXRhKTtcbiAgLy8gV2UgbmV2ZXIgY2hhbmdlIG9yaWdpbmFsRGF0YSwgc28gd2UgZG8gbm90IG5lZWQgYSBkZWVwIGNvcHlcbiAgdGhpcy5vcmlnaW5hbERhdGEgPSBvcmlnaW5hbERhdGE7XG5cbiAgLy8gVGhlIHRpbWVzdGFtcCB3ZSdsbCB1c2UgZm9yIHRoaXMgd2hvbGUgb3BlcmF0aW9uXG4gIHRoaXMudXBkYXRlZEF0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKS5pc287XG59XG5cbi8vIEEgY29udmVuaWVudCBtZXRob2QgdG8gcGVyZm9ybSBhbGwgdGhlIHN0ZXBzIG9mIHByb2Nlc3NpbmcgdGhlXG4vLyB3cml0ZSwgaW4gb3JkZXIuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSB7cmVzcG9uc2UsIHN0YXR1cywgbG9jYXRpb259IG9iamVjdC5cbi8vIHN0YXR1cyBhbmQgbG9jYXRpb24gYXJlIG9wdGlvbmFsLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5leGVjdXRlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmdldFVzZXJBbmRSb2xlQUNMKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24oKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUluc3RhbGxhdGlvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlU2Vzc2lvbigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudmFsaWRhdGVBdXRoRGF0YSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMucnVuQmVmb3JlU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlbGV0ZUVtYWlsUmVzZXRUb2tlbklmTmVlZGVkKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy52YWxpZGF0ZVNjaGVtYSgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuc2V0UmVxdWlyZWRGaWVsZHNJZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMudHJhbnNmb3JtVXNlcigpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmRlc3Ryb3lEdXBsaWNhdGVkU2Vzc2lvbnMoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkRhdGFiYXNlT3BlcmF0aW9uKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCgpO1xuICAgIH0pXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlRm9sbG93dXAoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLnJ1bkFmdGVyU2F2ZVRyaWdnZXIoKTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNsZWFuVXNlckF1dGhEYXRhKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5yZXNwb25zZTtcbiAgICB9KTtcbn07XG5cbi8vIFVzZXMgdGhlIEF1dGggb2JqZWN0IHRvIGdldCB0aGUgbGlzdCBvZiByb2xlcywgYWRkcyB0aGUgdXNlciBpZFxuUmVzdFdyaXRlLnByb3RvdHlwZS5nZXRVc2VyQW5kUm9sZUFDTCA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgdGhpcy5ydW5PcHRpb25zLmFjbCA9IFsnKiddO1xuXG4gIGlmICh0aGlzLmF1dGgudXNlcikge1xuICAgIHJldHVybiB0aGlzLmF1dGguZ2V0VXNlclJvbGVzKCkudGhlbihyb2xlcyA9PiB7XG4gICAgICB0aGlzLnJ1bk9wdGlvbnMuYWNsID0gdGhpcy5ydW5PcHRpb25zLmFjbC5jb25jYXQocm9sZXMsIFtcbiAgICAgICAgdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBdKTtcbiAgICAgIHJldHVybjtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbn07XG5cbi8vIFZhbGlkYXRlcyB0aGlzIG9wZXJhdGlvbiBhZ2FpbnN0IHRoZSBhbGxvd0NsaWVudENsYXNzQ3JlYXRpb24gY29uZmlnLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZUNsaWVudENsYXNzQ3JlYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKFxuICAgIHRoaXMuY29uZmlnLmFsbG93Q2xpZW50Q2xhc3NDcmVhdGlvbiA9PT0gZmFsc2UgJiZcbiAgICAhdGhpcy5hdXRoLmlzTWFzdGVyICYmXG4gICAgU2NoZW1hQ29udHJvbGxlci5zeXN0ZW1DbGFzc2VzLmluZGV4T2YodGhpcy5jbGFzc05hbWUpID09PSAtMVxuICApIHtcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5sb2FkU2NoZW1hKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5oYXNDbGFzcyh0aGlzLmNsYXNzTmFtZSkpXG4gICAgICAudGhlbihoYXNDbGFzcyA9PiB7XG4gICAgICAgIGlmIChoYXNDbGFzcyAhPT0gdHJ1ZSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9QRVJBVElPTl9GT1JCSURERU4sXG4gICAgICAgICAgICAnVGhpcyB1c2VyIGlzIG5vdCBhbGxvd2VkIHRvIGFjY2VzcyAnICtcbiAgICAgICAgICAgICAgJ25vbi1leGlzdGVudCBjbGFzczogJyArXG4gICAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59O1xuXG4vLyBWYWxpZGF0ZXMgdGhpcyBvcGVyYXRpb24gYWdhaW5zdCB0aGUgc2NoZW1hLlxuUmVzdFdyaXRlLnByb3RvdHlwZS52YWxpZGF0ZVNjaGVtYSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UudmFsaWRhdGVPYmplY3QoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdGhpcy5kYXRhLFxuICAgIHRoaXMucXVlcnksXG4gICAgdGhpcy5ydW5PcHRpb25zXG4gICk7XG59O1xuXG4vLyBSdW5zIGFueSBiZWZvcmVTYXZlIHRyaWdnZXJzIGFnYWluc3QgdGhpcyBvcGVyYXRpb24uXG4vLyBBbnkgY2hhbmdlIGxlYWRzIHRvIG91ciBkYXRhIGJlaW5nIG11dGF0ZWQuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZVNhdmVUcmlnZ2VyID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQXZvaWQgZG9pbmcgYW55IHNldHVwIGZvciB0cmlnZ2VycyBpZiB0aGVyZSBpcyBubyAnYmVmb3JlU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgaWYgKFxuICAgICF0cmlnZ2Vycy50cmlnZ2VyRXhpc3RzKFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLFxuICAgICAgdGhpcy5jb25maWcuYXBwbGljYXRpb25JZFxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gQ2xvdWQgY29kZSBnZXRzIGEgYml0IG9mIGV4dHJhIGRhdGEgZm9yIGl0cyBvYmplY3RzXG4gIHZhciBleHRyYURhdGEgPSB7IGNsYXNzTmFtZTogdGhpcy5jbGFzc05hbWUgfTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIGV4dHJhRGF0YS5vYmplY3RJZCA9IHRoaXMucXVlcnkub2JqZWN0SWQ7XG4gIH1cblxuICBsZXQgb3JpZ2luYWxPYmplY3QgPSBudWxsO1xuICBjb25zdCB1cGRhdGVkT2JqZWN0ID0gdGhpcy5idWlsZFVwZGF0ZWRPYmplY3QoZXh0cmFEYXRhKTtcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgIC8vIFRoaXMgaXMgYW4gdXBkYXRlIGZvciBleGlzdGluZyBvYmplY3QuXG4gICAgb3JpZ2luYWxPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICB9XG5cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgLy8gQmVmb3JlIGNhbGxpbmcgdGhlIHRyaWdnZXIsIHZhbGlkYXRlIHRoZSBwZXJtaXNzaW9ucyBmb3IgdGhlIHNhdmUgb3BlcmF0aW9uXG4gICAgICBsZXQgZGF0YWJhc2VQcm9taXNlID0gbnVsbDtcbiAgICAgIGlmICh0aGlzLnF1ZXJ5KSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciB1cGRhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS51cGRhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5xdWVyeSxcbiAgICAgICAgICB0aGlzLmRhdGEsXG4gICAgICAgICAgdGhpcy5ydW5PcHRpb25zLFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFZhbGlkYXRlIGZvciBjcmVhdGluZ1xuICAgICAgICBkYXRhYmFzZVByb21pc2UgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZS5jcmVhdGUoXG4gICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgdGhpcy5kYXRhLFxuICAgICAgICAgIHRoaXMucnVuT3B0aW9ucyxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBJbiB0aGUgY2FzZSB0aGF0IHRoZXJlIGlzIG5vIHBlcm1pc3Npb24gZm9yIHRoZSBvcGVyYXRpb24sIGl0IHRocm93cyBhbiBlcnJvclxuICAgICAgcmV0dXJuIGRhdGFiYXNlUHJvbWlzZS50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmICghcmVzdWx0IHx8IHJlc3VsdC5sZW5ndGggPD0gMCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAnT2JqZWN0IG5vdCBmb3VuZC4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgICB0cmlnZ2Vycy5UeXBlcy5iZWZvcmVTYXZlLFxuICAgICAgICB0aGlzLmF1dGgsXG4gICAgICAgIHVwZGF0ZWRPYmplY3QsXG4gICAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgICB0aGlzLmNvbmZpZyxcbiAgICAgICAgdGhpcy5jb250ZXh0XG4gICAgICApO1xuICAgIH0pXG4gICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgaWYgKHJlc3BvbnNlICYmIHJlc3BvbnNlLm9iamVjdCkge1xuICAgICAgICB0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlciA9IF8ucmVkdWNlKFxuICAgICAgICAgIHJlc3BvbnNlLm9iamVjdCxcbiAgICAgICAgICAocmVzdWx0LCB2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFcXVhbCh0aGlzLmRhdGFba2V5XSwgdmFsdWUpKSB7XG4gICAgICAgICAgICAgIHJlc3VsdC5wdXNoKGtleSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgIH0sXG4gICAgICAgICAgW11cbiAgICAgICAgKTtcbiAgICAgICAgdGhpcy5kYXRhID0gcmVzcG9uc2Uub2JqZWN0O1xuICAgICAgICAvLyBXZSBzaG91bGQgZGVsZXRlIHRoZSBvYmplY3RJZCBmb3IgYW4gdXBkYXRlIHdyaXRlXG4gICAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgICBkZWxldGUgdGhpcy5kYXRhLm9iamVjdElkO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlciA9IGFzeW5jIGZ1bmN0aW9uKHVzZXJEYXRhKSB7XG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2JlZm9yZUxvZ2luJyB0cmlnZ2VyXG4gIGlmIChcbiAgICAhdHJpZ2dlcnMudHJpZ2dlckV4aXN0cyhcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYmVmb3JlTG9naW4sXG4gICAgICB0aGlzLmNvbmZpZy5hcHBsaWNhdGlvbklkXG4gICAgKVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBDbG91ZCBjb2RlIGdldHMgYSBiaXQgb2YgZXh0cmEgZGF0YSBmb3IgaXRzIG9iamVjdHNcbiAgY29uc3QgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG4gIGNvbnN0IHVzZXIgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdXNlckRhdGEpO1xuXG4gIC8vIG5vIG5lZWQgdG8gcmV0dXJuIGEgcmVzcG9uc2VcbiAgYXdhaXQgdHJpZ2dlcnMubWF5YmVSdW5UcmlnZ2VyKFxuICAgIHRyaWdnZXJzLlR5cGVzLmJlZm9yZUxvZ2luLFxuICAgIHRoaXMuYXV0aCxcbiAgICB1c2VyLFxuICAgIG51bGwsXG4gICAgdGhpcy5jb25maWcsXG4gICAgdGhpcy5jb250ZXh0XG4gICk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLnNldFJlcXVpcmVkRmllbGRzSWZOZWVkZWQgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuZGF0YSkge1xuICAgIC8vIEFkZCBkZWZhdWx0IGZpZWxkc1xuICAgIHRoaXMuZGF0YS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICBpZiAoIXRoaXMucXVlcnkpIHtcbiAgICAgIHRoaXMuZGF0YS5jcmVhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcblxuICAgICAgLy8gT25seSBhc3NpZ24gbmV3IG9iamVjdElkIGlmIHdlIGFyZSBjcmVhdGluZyBuZXcgb2JqZWN0XG4gICAgICBpZiAoIXRoaXMuZGF0YS5vYmplY3RJZCkge1xuICAgICAgICB0aGlzLmRhdGEub2JqZWN0SWQgPSBjcnlwdG9VdGlscy5uZXdPYmplY3RJZCh0aGlzLmNvbmZpZy5vYmplY3RJZFNpemUpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG59O1xuXG4vLyBUcmFuc2Zvcm1zIGF1dGggZGF0YSBmb3IgYSB1c2VyIG9iamVjdC5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGEgdXNlciBvYmplY3QuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3Igd2hlbiB3ZSdyZSBkb25lIGlmIGl0IGNhbid0IGZpbmlzaCB0aGlzIHRpY2suXG5SZXN0V3JpdGUucHJvdG90eXBlLnZhbGlkYXRlQXV0aERhdGEgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmRhdGEuYXV0aERhdGEpIHtcbiAgICBpZiAoXG4gICAgICB0eXBlb2YgdGhpcy5kYXRhLnVzZXJuYW1lICE9PSAnc3RyaW5nJyB8fFxuICAgICAgXy5pc0VtcHR5KHRoaXMuZGF0YS51c2VybmFtZSlcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfTUlTU0lORyxcbiAgICAgICAgJ2JhZCBvciBtaXNzaW5nIHVzZXJuYW1lJ1xuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgdHlwZW9mIHRoaXMuZGF0YS5wYXNzd29yZCAhPT0gJ3N0cmluZycgfHxcbiAgICAgIF8uaXNFbXB0eSh0aGlzLmRhdGEucGFzc3dvcmQpXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLlBBU1NXT1JEX01JU1NJTkcsXG4gICAgICAgICdwYXNzd29yZCBpcyByZXF1aXJlZCdcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLmRhdGEuYXV0aERhdGEgfHwgIU9iamVjdC5rZXlzKHRoaXMuZGF0YS5hdXRoRGF0YSkubGVuZ3RoKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIGF1dGhEYXRhID0gdGhpcy5kYXRhLmF1dGhEYXRhO1xuICB2YXIgcHJvdmlkZXJzID0gT2JqZWN0LmtleXMoYXV0aERhdGEpO1xuICBpZiAocHJvdmlkZXJzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBjYW5IYW5kbGVBdXRoRGF0YSA9IHByb3ZpZGVycy5yZWR1Y2UoKGNhbkhhbmRsZSwgcHJvdmlkZXIpID0+IHtcbiAgICAgIHZhciBwcm92aWRlckF1dGhEYXRhID0gYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgdmFyIGhhc1Rva2VuID0gcHJvdmlkZXJBdXRoRGF0YSAmJiBwcm92aWRlckF1dGhEYXRhLmlkO1xuICAgICAgcmV0dXJuIGNhbkhhbmRsZSAmJiAoaGFzVG9rZW4gfHwgcHJvdmlkZXJBdXRoRGF0YSA9PSBudWxsKTtcbiAgICB9LCB0cnVlKTtcbiAgICBpZiAoY2FuSGFuZGxlQXV0aERhdGEpIHtcbiAgICAgIHJldHVybiB0aGlzLmhhbmRsZUF1dGhEYXRhKGF1dGhEYXRhKTtcbiAgICB9XG4gIH1cbiAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgIFBhcnNlLkVycm9yLlVOU1VQUE9SVEVEX1NFUlZJQ0UsXG4gICAgJ1RoaXMgYXV0aGVudGljYXRpb24gbWV0aG9kIGlzIHVuc3VwcG9ydGVkLidcbiAgKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uID0gZnVuY3Rpb24oYXV0aERhdGEpIHtcbiAgY29uc3QgdmFsaWRhdGlvbnMgPSBPYmplY3Qua2V5cyhhdXRoRGF0YSkubWFwKHByb3ZpZGVyID0+IHtcbiAgICBpZiAoYXV0aERhdGFbcHJvdmlkZXJdID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgfVxuICAgIGNvbnN0IHZhbGlkYXRlQXV0aERhdGEgPSB0aGlzLmNvbmZpZy5hdXRoRGF0YU1hbmFnZXIuZ2V0VmFsaWRhdG9yRm9yUHJvdmlkZXIoXG4gICAgICBwcm92aWRlclxuICAgICk7XG4gICAgaWYgKCF2YWxpZGF0ZUF1dGhEYXRhKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLlVOU1VQUE9SVEVEX1NFUlZJQ0UsXG4gICAgICAgICdUaGlzIGF1dGhlbnRpY2F0aW9uIG1ldGhvZCBpcyB1bnN1cHBvcnRlZC4nXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gdmFsaWRhdGVBdXRoRGF0YShhdXRoRGF0YVtwcm92aWRlcl0pO1xuICB9KTtcbiAgcmV0dXJuIFByb21pc2UuYWxsKHZhbGlkYXRpb25zKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuZmluZFVzZXJzV2l0aEF1dGhEYXRhID0gZnVuY3Rpb24oYXV0aERhdGEpIHtcbiAgY29uc3QgcHJvdmlkZXJzID0gT2JqZWN0LmtleXMoYXV0aERhdGEpO1xuICBjb25zdCBxdWVyeSA9IHByb3ZpZGVyc1xuICAgIC5yZWR1Y2UoKG1lbW8sIHByb3ZpZGVyKSA9PiB7XG4gICAgICBpZiAoIWF1dGhEYXRhW3Byb3ZpZGVyXSkge1xuICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgIH1cbiAgICAgIGNvbnN0IHF1ZXJ5S2V5ID0gYGF1dGhEYXRhLiR7cHJvdmlkZXJ9LmlkYDtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0ge307XG4gICAgICBxdWVyeVtxdWVyeUtleV0gPSBhdXRoRGF0YVtwcm92aWRlcl0uaWQ7XG4gICAgICBtZW1vLnB1c2gocXVlcnkpO1xuICAgICAgcmV0dXJuIG1lbW87XG4gICAgfSwgW10pXG4gICAgLmZpbHRlcihxID0+IHtcbiAgICAgIHJldHVybiB0eXBlb2YgcSAhPT0gJ3VuZGVmaW5lZCc7XG4gICAgfSk7XG5cbiAgbGV0IGZpbmRQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgaWYgKHF1ZXJ5Lmxlbmd0aCA+IDApIHtcbiAgICBmaW5kUHJvbWlzZSA9IHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQodGhpcy5jbGFzc05hbWUsIHsgJG9yOiBxdWVyeSB9LCB7fSk7XG4gIH1cblxuICByZXR1cm4gZmluZFByb21pc2U7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmZpbHRlcmVkT2JqZWN0c0J5QUNMID0gZnVuY3Rpb24ob2JqZWN0cykge1xuICBpZiAodGhpcy5hdXRoLmlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIG9iamVjdHM7XG4gIH1cbiAgcmV0dXJuIG9iamVjdHMuZmlsdGVyKG9iamVjdCA9PiB7XG4gICAgaWYgKCFvYmplY3QuQUNMKSB7XG4gICAgICByZXR1cm4gdHJ1ZTsgLy8gbGVnYWN5IHVzZXJzIHRoYXQgaGF2ZSBubyBBQ0wgZmllbGQgb24gdGhlbVxuICAgIH1cbiAgICAvLyBSZWd1bGFyIHVzZXJzIHRoYXQgaGF2ZSBiZWVuIGxvY2tlZCBvdXQuXG4gICAgcmV0dXJuIG9iamVjdC5BQ0wgJiYgT2JqZWN0LmtleXMob2JqZWN0LkFDTCkubGVuZ3RoID4gMDtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmhhbmRsZUF1dGhEYXRhID0gZnVuY3Rpb24oYXV0aERhdGEpIHtcbiAgbGV0IHJlc3VsdHM7XG4gIHJldHVybiB0aGlzLmZpbmRVc2Vyc1dpdGhBdXRoRGF0YShhdXRoRGF0YSkudGhlbihhc3luYyByID0+IHtcbiAgICByZXN1bHRzID0gdGhpcy5maWx0ZXJlZE9iamVjdHNCeUFDTChyKTtcbiAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAxKSB7XG4gICAgICAvLyBNb3JlIHRoYW4gMSB1c2VyIHdpdGggdGhlIHBhc3NlZCBpZCdzXG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsXG4gICAgICAgICd0aGlzIGF1dGggaXMgYWxyZWFkeSB1c2VkJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aGlzLnN0b3JhZ2VbJ2F1dGhQcm92aWRlciddID0gT2JqZWN0LmtleXMoYXV0aERhdGEpLmpvaW4oJywnKTtcblxuICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHVzZXJSZXN1bHQgPSByZXN1bHRzWzBdO1xuICAgICAgY29uc3QgbXV0YXRlZEF1dGhEYXRhID0ge307XG4gICAgICBPYmplY3Qua2V5cyhhdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGNvbnN0IHByb3ZpZGVyRGF0YSA9IGF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgY29uc3QgdXNlckF1dGhEYXRhID0gdXNlclJlc3VsdC5hdXRoRGF0YVtwcm92aWRlcl07XG4gICAgICAgIGlmICghXy5pc0VxdWFsKHByb3ZpZGVyRGF0YSwgdXNlckF1dGhEYXRhKSkge1xuICAgICAgICAgIG11dGF0ZWRBdXRoRGF0YVtwcm92aWRlcl0gPSBwcm92aWRlckRhdGE7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFzTXV0YXRlZEF1dGhEYXRhID0gT2JqZWN0LmtleXMobXV0YXRlZEF1dGhEYXRhKS5sZW5ndGggIT09IDA7XG4gICAgICBsZXQgdXNlcklkO1xuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCkge1xuICAgICAgICB1c2VySWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICAgICAgfSBlbHNlIGlmICh0aGlzLmF1dGggJiYgdGhpcy5hdXRoLnVzZXIgJiYgdGhpcy5hdXRoLnVzZXIuaWQpIHtcbiAgICAgICAgdXNlcklkID0gdGhpcy5hdXRoLnVzZXIuaWQ7XG4gICAgICB9XG4gICAgICBpZiAoIXVzZXJJZCB8fCB1c2VySWQgPT09IHVzZXJSZXN1bHQub2JqZWN0SWQpIHtcbiAgICAgICAgLy8gbm8gdXNlciBtYWtpbmcgdGhlIGNhbGxcbiAgICAgICAgLy8gT1IgdGhlIHVzZXIgbWFraW5nIHRoZSBjYWxsIGlzIHRoZSByaWdodCBvbmVcbiAgICAgICAgLy8gTG9naW4gd2l0aCBhdXRoIGRhdGFcbiAgICAgICAgZGVsZXRlIHJlc3VsdHNbMF0ucGFzc3dvcmQ7XG5cbiAgICAgICAgLy8gbmVlZCB0byBzZXQgdGhlIG9iamVjdElkIGZpcnN0IG90aGVyd2lzZSBsb2NhdGlvbiBoYXMgdHJhaWxpbmcgdW5kZWZpbmVkXG4gICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCA9IHVzZXJSZXN1bHQub2JqZWN0SWQ7XG5cbiAgICAgICAgaWYgKCF0aGlzLnF1ZXJ5IHx8ICF0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgICAgICAgLy8gdGhpcyBhIGxvZ2luIGNhbGwsIG5vIHVzZXJJZCBwYXNzZWRcbiAgICAgICAgICB0aGlzLnJlc3BvbnNlID0ge1xuICAgICAgICAgICAgcmVzcG9uc2U6IHVzZXJSZXN1bHQsXG4gICAgICAgICAgICBsb2NhdGlvbjogdGhpcy5sb2NhdGlvbigpLFxuICAgICAgICAgIH07XG4gICAgICAgICAgLy8gUnVuIGJlZm9yZUxvZ2luIGhvb2sgYmVmb3JlIHN0b3JpbmcgYW55IHVwZGF0ZXNcbiAgICAgICAgICAvLyB0byBhdXRoRGF0YSBvbiB0aGUgZGI7IGNoYW5nZXMgdG8gdXNlclJlc3VsdFxuICAgICAgICAgIC8vIHdpbGwgYmUgaWdub3JlZC5cbiAgICAgICAgICBhd2FpdCB0aGlzLnJ1bkJlZm9yZUxvZ2luVHJpZ2dlcihkZWVwY29weSh1c2VyUmVzdWx0KSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB3ZSBkaWRuJ3QgY2hhbmdlIHRoZSBhdXRoIGRhdGEsIGp1c3Qga2VlcCBnb2luZ1xuICAgICAgICBpZiAoIWhhc011dGF0ZWRBdXRoRGF0YSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICAvLyBXZSBoYXZlIGF1dGhEYXRhIHRoYXQgaXMgdXBkYXRlZCBvbiBsb2dpblxuICAgICAgICAvLyB0aGF0IGNhbiBoYXBwZW4gd2hlbiB0b2tlbiBhcmUgcmVmcmVzaGVkLFxuICAgICAgICAvLyBXZSBzaG91bGQgdXBkYXRlIHRoZSB0b2tlbiBhbmQgbGV0IHRoZSB1c2VyIGluXG4gICAgICAgIC8vIFdlIHNob3VsZCBvbmx5IGNoZWNrIHRoZSBtdXRhdGVkIGtleXNcbiAgICAgICAgcmV0dXJuIHRoaXMuaGFuZGxlQXV0aERhdGFWYWxpZGF0aW9uKG11dGF0ZWRBdXRoRGF0YSkudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgICAgLy8gSUYgd2UgaGF2ZSBhIHJlc3BvbnNlLCB3ZSdsbCBza2lwIHRoZSBkYXRhYmFzZSBvcGVyYXRpb24gLyBiZWZvcmVTYXZlIC8gYWZ0ZXJTYXZlIGV0Yy4uLlxuICAgICAgICAgIC8vIHdlIG5lZWQgdG8gc2V0IGl0IHVwIHRoZXJlLlxuICAgICAgICAgIC8vIFdlIGFyZSBzdXBwb3NlZCB0byBoYXZlIGEgcmVzcG9uc2Ugb25seSBvbiBMT0dJTiB3aXRoIGF1dGhEYXRhLCBzbyB3ZSBza2lwIHRob3NlXG4gICAgICAgICAgLy8gSWYgd2UncmUgbm90IGxvZ2dpbmcgaW4sIGJ1dCBqdXN0IHVwZGF0aW5nIHRoZSBjdXJyZW50IHVzZXIsIHdlIGNhbiBzYWZlbHkgc2tpcCB0aGF0IHBhcnRcbiAgICAgICAgICBpZiAodGhpcy5yZXNwb25zZSkge1xuICAgICAgICAgICAgLy8gQXNzaWduIHRoZSBuZXcgYXV0aERhdGEgaW4gdGhlIHJlc3BvbnNlXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhtdXRhdGVkQXV0aERhdGEpLmZvckVhY2gocHJvdmlkZXIgPT4ge1xuICAgICAgICAgICAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLmF1dGhEYXRhW3Byb3ZpZGVyXSA9XG4gICAgICAgICAgICAgICAgbXV0YXRlZEF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAvLyBSdW4gdGhlIERCIHVwZGF0ZSBkaXJlY3RseSwgYXMgJ21hc3RlcidcbiAgICAgICAgICAgIC8vIEp1c3QgdXBkYXRlIHRoZSBhdXRoRGF0YSBwYXJ0XG4gICAgICAgICAgICAvLyBUaGVuIHdlJ3JlIGdvb2QgZm9yIHRoZSB1c2VyLCBlYXJseSBleGl0IG9mIHNvcnRzXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2UudXBkYXRlKFxuICAgICAgICAgICAgICB0aGlzLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgeyBvYmplY3RJZDogdGhpcy5kYXRhLm9iamVjdElkIH0sXG4gICAgICAgICAgICAgIHsgYXV0aERhdGE6IG11dGF0ZWRBdXRoRGF0YSB9LFxuICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIGlmICh1c2VySWQpIHtcbiAgICAgICAgLy8gVHJ5aW5nIHRvIHVwZGF0ZSBhdXRoIGRhdGEgYnV0IHVzZXJzXG4gICAgICAgIC8vIGFyZSBkaWZmZXJlbnRcbiAgICAgICAgaWYgKHVzZXJSZXN1bHQub2JqZWN0SWQgIT09IHVzZXJJZCkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkFDQ09VTlRfQUxSRUFEWV9MSU5LRUQsXG4gICAgICAgICAgICAndGhpcyBhdXRoIGlzIGFscmVhZHkgdXNlZCdcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5vIGF1dGggZGF0YSB3YXMgbXV0YXRlZCwganVzdCBrZWVwIGdvaW5nXG4gICAgICAgIGlmICghaGFzTXV0YXRlZEF1dGhEYXRhKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmhhbmRsZUF1dGhEYXRhVmFsaWRhdGlvbihhdXRoRGF0YSk7XG4gIH0pO1xufTtcblxuLy8gVGhlIG5vbi10aGlyZC1wYXJ0eSBwYXJ0cyBvZiBVc2VyIHRyYW5zZm9ybWF0aW9uXG5SZXN0V3JpdGUucHJvdG90eXBlLnRyYW5zZm9ybVVzZXIgPSBmdW5jdGlvbigpIHtcbiAgdmFyIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKTtcblxuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLmlzTWFzdGVyICYmICdlbWFpbFZlcmlmaWVkJyBpbiB0aGlzLmRhdGEpIHtcbiAgICBjb25zdCBlcnJvciA9IGBDbGllbnRzIGFyZW4ndCBhbGxvd2VkIHRvIG1hbnVhbGx5IHVwZGF0ZSBlbWFpbCB2ZXJpZmljYXRpb24uYDtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTiwgZXJyb3IpO1xuICB9XG5cbiAgLy8gRG8gbm90IGNsZWFudXAgc2Vzc2lvbiBpZiBvYmplY3RJZCBpcyBub3Qgc2V0XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMub2JqZWN0SWQoKSkge1xuICAgIC8vIElmIHdlJ3JlIHVwZGF0aW5nIGEgX1VzZXIgb2JqZWN0LCB3ZSBuZWVkIHRvIGNsZWFyIG91dCB0aGUgY2FjaGUgZm9yIHRoYXQgdXNlci4gRmluZCBhbGwgdGhlaXJcbiAgICAvLyBzZXNzaW9uIHRva2VucywgYW5kIHJlbW92ZSB0aGVtIGZyb20gdGhlIGNhY2hlLlxuICAgIHByb21pc2UgPSBuZXcgUmVzdFF1ZXJ5KHRoaXMuY29uZmlnLCBBdXRoLm1hc3Rlcih0aGlzLmNvbmZpZyksICdfU2Vzc2lvbicsIHtcbiAgICAgIHVzZXI6IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSxcbiAgICAgIH0sXG4gICAgfSlcbiAgICAgIC5leGVjdXRlKClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICByZXN1bHRzLnJlc3VsdHMuZm9yRWFjaChzZXNzaW9uID0+XG4gICAgICAgICAgdGhpcy5jb25maWcuY2FjaGVDb250cm9sbGVyLnVzZXIuZGVsKHNlc3Npb24uc2Vzc2lvblRva2VuKVxuICAgICAgICApO1xuICAgICAgfSk7XG4gIH1cblxuICByZXR1cm4gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIC8vIFRyYW5zZm9ybSB0aGUgcGFzc3dvcmRcbiAgICAgIGlmICh0aGlzLmRhdGEucGFzc3dvcmQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBpZ25vcmUgb25seSBpZiB1bmRlZmluZWQuIHNob3VsZCBwcm9jZWVkIGlmIGVtcHR5ICgnJylcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5xdWVyeSkge1xuICAgICAgICB0aGlzLnN0b3JhZ2VbJ2NsZWFyU2Vzc2lvbnMnXSA9IHRydWU7XG4gICAgICAgIC8vIEdlbmVyYXRlIGEgbmV3IHNlc3Npb24gb25seSBpZiB0aGUgdXNlciByZXF1ZXN0ZWRcbiAgICAgICAgaWYgKCF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICAgICAgICB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZFBvbGljeSgpLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gcGFzc3dvcmRDcnlwdG8uaGFzaCh0aGlzLmRhdGEucGFzc3dvcmQpLnRoZW4oaGFzaGVkUGFzc3dvcmQgPT4ge1xuICAgICAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkID0gaGFzaGVkUGFzc3dvcmQ7XG4gICAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5wYXNzd29yZDtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLl92YWxpZGF0ZVVzZXJOYW1lKCk7XG4gICAgfSlcbiAgICAudGhlbigoKSA9PiB7XG4gICAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVFbWFpbCgpO1xuICAgIH0pO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5fdmFsaWRhdGVVc2VyTmFtZSA9IGZ1bmN0aW9uKCkge1xuICAvLyBDaGVjayBmb3IgdXNlcm5hbWUgdW5pcXVlbmVzc1xuICBpZiAoIXRoaXMuZGF0YS51c2VybmFtZSkge1xuICAgIGlmICghdGhpcy5xdWVyeSkge1xuICAgICAgdGhpcy5kYXRhLnVzZXJuYW1lID0gY3J5cHRvVXRpbHMucmFuZG9tU3RyaW5nKDI1KTtcbiAgICAgIHRoaXMucmVzcG9uc2VTaG91bGRIYXZlVXNlcm5hbWUgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8gV2UgbmVlZCB0byBhIGZpbmQgdG8gY2hlY2sgZm9yIGR1cGxpY2F0ZSB1c2VybmFtZSBpbiBjYXNlIHRoZXkgYXJlIG1pc3NpbmcgdGhlIHVuaXF1ZSBpbmRleCBvbiB1c2VybmFtZXNcbiAgLy8gVE9ETzogQ2hlY2sgaWYgdGhlcmUgaXMgYSB1bmlxdWUgaW5kZXgsIGFuZCBpZiBzbywgc2tpcCB0aGlzIHF1ZXJ5LlxuICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAuZmluZChcbiAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgeyB1c2VybmFtZTogdGhpcy5kYXRhLnVzZXJuYW1lLCBvYmplY3RJZDogeyAkbmU6IHRoaXMub2JqZWN0SWQoKSB9IH0sXG4gICAgICB7IGxpbWl0OiAxIH1cbiAgICApXG4gICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyB1c2VybmFtZS4nXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZUVtYWlsID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5kYXRhLmVtYWlsIHx8IHRoaXMuZGF0YS5lbWFpbC5fX29wID09PSAnRGVsZXRlJykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuICAvLyBWYWxpZGF0ZSBiYXNpYyBlbWFpbCBhZGRyZXNzIGZvcm1hdFxuICBpZiAoIXRoaXMuZGF0YS5lbWFpbC5tYXRjaCgvXi4rQC4rJC8pKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0VNQUlMX0FERFJFU1MsXG4gICAgICAgICdFbWFpbCBhZGRyZXNzIGZvcm1hdCBpcyBpbnZhbGlkLidcbiAgICAgIClcbiAgICApO1xuICB9XG4gIC8vIFNhbWUgcHJvYmxlbSBmb3IgZW1haWwgYXMgYWJvdmUgZm9yIHVzZXJuYW1lXG4gIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgIC5maW5kKFxuICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICB7IGVtYWlsOiB0aGlzLmRhdGEuZW1haWwsIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0gfSxcbiAgICAgIHsgbGltaXQ6IDEgfVxuICAgIClcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGVtYWlsIGFkZHJlc3MuJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICAhdGhpcy5kYXRhLmF1dGhEYXRhIHx8XG4gICAgICAgICFPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpLmxlbmd0aCB8fFxuICAgICAgICAoT2JqZWN0LmtleXModGhpcy5kYXRhLmF1dGhEYXRhKS5sZW5ndGggPT09IDEgJiZcbiAgICAgICAgICBPYmplY3Qua2V5cyh0aGlzLmRhdGEuYXV0aERhdGEpWzBdID09PSAnYW5vbnltb3VzJylcbiAgICAgICkge1xuICAgICAgICAvLyBXZSB1cGRhdGVkIHRoZSBlbWFpbCwgc2VuZCBhIG5ldyB2YWxpZGF0aW9uXG4gICAgICAgIHRoaXMuc3RvcmFnZVsnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJ10gPSB0cnVlO1xuICAgICAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZXRFbWFpbFZlcmlmeVRva2VuKHRoaXMuZGF0YSk7XG4gICAgICB9XG4gICAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkUG9saWN5ID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kpIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgcmV0dXJuIHRoaXMuX3ZhbGlkYXRlUGFzc3dvcmRSZXF1aXJlbWVudHMoKS50aGVuKCgpID0+IHtcbiAgICByZXR1cm4gdGhpcy5fdmFsaWRhdGVQYXNzd29yZEhpc3RvcnkoKTtcbiAgfSk7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl92YWxpZGF0ZVBhc3N3b3JkUmVxdWlyZW1lbnRzID0gZnVuY3Rpb24oKSB7XG4gIC8vIGNoZWNrIGlmIHRoZSBwYXNzd29yZCBjb25mb3JtcyB0byB0aGUgZGVmaW5lZCBwYXNzd29yZCBwb2xpY3kgaWYgY29uZmlndXJlZFxuICAvLyBJZiB3ZSBzcGVjaWZpZWQgYSBjdXN0b20gZXJyb3IgaW4gb3VyIGNvbmZpZ3VyYXRpb24gdXNlIGl0LlxuICAvLyBFeGFtcGxlOiBcIlBhc3N3b3JkcyBtdXN0IGluY2x1ZGUgYSBDYXBpdGFsIExldHRlciwgTG93ZXJjYXNlIExldHRlciwgYW5kIGEgbnVtYmVyLlwiXG4gIC8vXG4gIC8vIFRoaXMgaXMgZXNwZWNpYWxseSB1c2VmdWwgb24gdGhlIGdlbmVyaWMgXCJwYXNzd29yZCByZXNldFwiIHBhZ2UsXG4gIC8vIGFzIGl0IGFsbG93cyB0aGUgcHJvZ3JhbW1lciB0byBjb21tdW5pY2F0ZSBzcGVjaWZpYyByZXF1aXJlbWVudHMgaW5zdGVhZCBvZjpcbiAgLy8gYS4gbWFraW5nIHRoZSB1c2VyIGd1ZXNzIHdoYXRzIHdyb25nXG4gIC8vIGIuIG1ha2luZyBhIGN1c3RvbSBwYXNzd29yZCByZXNldCBwYWdlIHRoYXQgc2hvd3MgdGhlIHJlcXVpcmVtZW50c1xuICBjb25zdCBwb2xpY3lFcnJvciA9IHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRpb25FcnJvclxuICAgID8gdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kudmFsaWRhdGlvbkVycm9yXG4gICAgOiAnUGFzc3dvcmQgZG9lcyBub3QgbWVldCB0aGUgUGFzc3dvcmQgUG9saWN5IHJlcXVpcmVtZW50cy4nO1xuICBjb25zdCBjb250YWluc1VzZXJuYW1lRXJyb3IgPSAnUGFzc3dvcmQgY2Fubm90IGNvbnRhaW4geW91ciB1c2VybmFtZS4nO1xuXG4gIC8vIGNoZWNrIHdoZXRoZXIgdGhlIHBhc3N3b3JkIG1lZXRzIHRoZSBwYXNzd29yZCBzdHJlbmd0aCByZXF1aXJlbWVudHNcbiAgaWYgKFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5wYXR0ZXJuVmFsaWRhdG9yICYmXG4gICAgICAhdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kucGF0dGVyblZhbGlkYXRvcih0aGlzLmRhdGEucGFzc3dvcmQpKSB8fFxuICAgICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS52YWxpZGF0b3JDYWxsYmFjayAmJlxuICAgICAgIXRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5LnZhbGlkYXRvckNhbGxiYWNrKHRoaXMuZGF0YS5wYXNzd29yZCkpXG4gICkge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBwb2xpY3lFcnJvcilcbiAgICApO1xuICB9XG5cbiAgLy8gY2hlY2sgd2hldGhlciBwYXNzd29yZCBjb250YWluIHVzZXJuYW1lXG4gIGlmICh0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5kb05vdEFsbG93VXNlcm5hbWUgPT09IHRydWUpIHtcbiAgICBpZiAodGhpcy5kYXRhLnVzZXJuYW1lKSB7XG4gICAgICAvLyB1c2VybmFtZSBpcyBub3QgcGFzc2VkIGR1cmluZyBwYXNzd29yZCByZXNldFxuICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHRoaXMuZGF0YS51c2VybmFtZSkgPj0gMClcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KFxuICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLCBjb250YWluc1VzZXJuYW1lRXJyb3IpXG4gICAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHJldHJpZXZlIHRoZSBVc2VyIG9iamVjdCB1c2luZyBvYmplY3RJZCBkdXJpbmcgcGFzc3dvcmQgcmVzZXRcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZCgnX1VzZXInLCB7IG9iamVjdElkOiB0aGlzLm9iamVjdElkKCkgfSlcbiAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoICE9IDEpIHtcbiAgICAgICAgICAgIHRocm93IHVuZGVmaW5lZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5wYXNzd29yZC5pbmRleE9mKHJlc3VsdHNbMF0udXNlcm5hbWUpID49IDApXG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgICAgIG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgIGNvbnRhaW5zVXNlcm5hbWVFcnJvclxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuX3ZhbGlkYXRlUGFzc3dvcmRIaXN0b3J5ID0gZnVuY3Rpb24oKSB7XG4gIC8vIGNoZWNrIHdoZXRoZXIgcGFzc3dvcmQgaXMgcmVwZWF0aW5nIGZyb20gc3BlY2lmaWVkIGhpc3RvcnlcbiAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5KSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAuZmluZChcbiAgICAgICAgJ19Vc2VyJyxcbiAgICAgICAgeyBvYmplY3RJZDogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfVxuICAgICAgKVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICBsZXQgb2xkUGFzc3dvcmRzID0gW107XG4gICAgICAgIGlmICh1c2VyLl9wYXNzd29yZF9oaXN0b3J5KVxuICAgICAgICAgIG9sZFBhc3N3b3JkcyA9IF8udGFrZShcbiAgICAgICAgICAgIHVzZXIuX3Bhc3N3b3JkX2hpc3RvcnksXG4gICAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnkgLSAxXG4gICAgICAgICAgKTtcbiAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgIGNvbnN0IG5ld1Bhc3N3b3JkID0gdGhpcy5kYXRhLnBhc3N3b3JkO1xuICAgICAgICAvLyBjb21wYXJlIHRoZSBuZXcgcGFzc3dvcmQgaGFzaCB3aXRoIGFsbCBvbGQgcGFzc3dvcmQgaGFzaGVzXG4gICAgICAgIGNvbnN0IHByb21pc2VzID0gb2xkUGFzc3dvcmRzLm1hcChmdW5jdGlvbihoYXNoKSB7XG4gICAgICAgICAgcmV0dXJuIHBhc3N3b3JkQ3J5cHRvLmNvbXBhcmUobmV3UGFzc3dvcmQsIGhhc2gpLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHQpXG4gICAgICAgICAgICAgIC8vIHJlamVjdCBpZiB0aGVyZSBpcyBhIG1hdGNoXG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdCgnUkVQRUFUX1BBU1NXT1JEJyk7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgICAvLyB3YWl0IGZvciBhbGwgY29tcGFyaXNvbnMgdG8gY29tcGxldGVcbiAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKVxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgaWYgKGVyciA9PT0gJ1JFUEVBVF9QQVNTV09SRCcpXG4gICAgICAgICAgICAgIC8vIGEgbWF0Y2ggd2FzIGZvdW5kXG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgICAgICAgICBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5WQUxJREFUSU9OX0VSUk9SLFxuICAgICAgICAgICAgICAgICAgYE5ldyBwYXNzd29yZCBzaG91bGQgbm90IGJlIHRoZSBzYW1lIGFzIGxhc3QgJHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRIaXN0b3J5XG4gICAgICAgICAgICAgICAgICB9IHBhc3N3b3Jkcy5gXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5jcmVhdGVTZXNzaW9uVG9rZW5JZk5lZWRlZCA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5jbGFzc05hbWUgIT09ICdfVXNlcicpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHRoaXMucXVlcnkpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKFxuICAgICF0aGlzLnN0b3JhZ2VbJ2F1dGhQcm92aWRlciddICYmIC8vIHNpZ251cCBjYWxsLCB3aXRoXG4gICAgdGhpcy5jb25maWcucHJldmVudExvZ2luV2l0aFVudmVyaWZpZWRFbWFpbCAmJiAvLyBubyBsb2dpbiB3aXRob3V0IHZlcmlmaWNhdGlvblxuICAgIHRoaXMuY29uZmlnLnZlcmlmeVVzZXJFbWFpbHNcbiAgKSB7XG4gICAgLy8gdmVyaWZpY2F0aW9uIGlzIG9uXG4gICAgcmV0dXJuOyAvLyBkbyBub3QgY3JlYXRlIHRoZSBzZXNzaW9uIHRva2VuIGluIHRoYXQgY2FzZSFcbiAgfVxuICByZXR1cm4gdGhpcy5jcmVhdGVTZXNzaW9uVG9rZW4oKTtcbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUuY3JlYXRlU2Vzc2lvblRva2VuID0gZnVuY3Rpb24oKSB7XG4gIC8vIGNsb3VkIGluc3RhbGxhdGlvbklkIGZyb20gQ2xvdWQgQ29kZSxcbiAgLy8gbmV2ZXIgY3JlYXRlIHNlc3Npb24gdG9rZW5zIGZyb20gdGhlcmUuXG4gIGlmICh0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWQgJiYgdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkID09PSAnY2xvdWQnKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgeyBzZXNzaW9uRGF0YSwgY3JlYXRlU2Vzc2lvbiB9ID0gQXV0aC5jcmVhdGVTZXNzaW9uKHRoaXMuY29uZmlnLCB7XG4gICAgdXNlcklkOiB0aGlzLm9iamVjdElkKCksXG4gICAgY3JlYXRlZFdpdGg6IHtcbiAgICAgIGFjdGlvbjogdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSA/ICdsb2dpbicgOiAnc2lnbnVwJyxcbiAgICAgIGF1dGhQcm92aWRlcjogdGhpcy5zdG9yYWdlWydhdXRoUHJvdmlkZXInXSB8fCAncGFzc3dvcmQnLFxuICAgIH0sXG4gICAgaW5zdGFsbGF0aW9uSWQ6IHRoaXMuYXV0aC5pbnN0YWxsYXRpb25JZCxcbiAgfSk7XG5cbiAgaWYgKHRoaXMucmVzcG9uc2UgJiYgdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHRoaXMucmVzcG9uc2UucmVzcG9uc2Uuc2Vzc2lvblRva2VuID0gc2Vzc2lvbkRhdGEuc2Vzc2lvblRva2VuO1xuICB9XG5cbiAgcmV0dXJuIGNyZWF0ZVNlc3Npb24oKTtcbn07XG5cbi8vIERlbGV0ZSBlbWFpbCByZXNldCB0b2tlbnMgaWYgdXNlciBpcyBjaGFuZ2luZyBwYXNzd29yZCBvciBlbWFpbC5cblJlc3RXcml0ZS5wcm90b3R5cGUuZGVsZXRlRW1haWxSZXNldFRva2VuSWZOZWVkZWQgPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8IHRoaXMucXVlcnkgPT09IG51bGwpIHtcbiAgICAvLyBudWxsIHF1ZXJ5IG1lYW5zIGNyZWF0ZVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgncGFzc3dvcmQnIGluIHRoaXMuZGF0YSB8fCAnZW1haWwnIGluIHRoaXMuZGF0YSkge1xuICAgIGNvbnN0IGFkZE9wcyA9IHtcbiAgICAgIF9wZXJpc2hhYmxlX3Rva2VuOiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgICBfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0OiB7IF9fb3A6ICdEZWxldGUnIH0sXG4gICAgfTtcbiAgICB0aGlzLmRhdGEgPSBPYmplY3QuYXNzaWduKHRoaXMuZGF0YSwgYWRkT3BzKTtcbiAgfVxufTtcblxuUmVzdFdyaXRlLnByb3RvdHlwZS5kZXN0cm95RHVwbGljYXRlZFNlc3Npb25zID0gZnVuY3Rpb24oKSB7XG4gIC8vIE9ubHkgZm9yIF9TZXNzaW9uLCBhbmQgYXQgY3JlYXRpb24gdGltZVxuICBpZiAodGhpcy5jbGFzc05hbWUgIT0gJ19TZXNzaW9uJyB8fCB0aGlzLnF1ZXJ5KSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIERlc3Ryb3kgdGhlIHNlc3Npb25zIGluICdCYWNrZ3JvdW5kJ1xuICBjb25zdCB7IHVzZXIsIGluc3RhbGxhdGlvbklkLCBzZXNzaW9uVG9rZW4gfSA9IHRoaXMuZGF0YTtcbiAgaWYgKCF1c2VyIHx8ICFpbnN0YWxsYXRpb25JZCkge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIXVzZXIub2JqZWN0SWQpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdGhpcy5jb25maWcuZGF0YWJhc2UuZGVzdHJveSgnX1Nlc3Npb24nLCB7XG4gICAgdXNlcixcbiAgICBpbnN0YWxsYXRpb25JZCxcbiAgICBzZXNzaW9uVG9rZW46IHsgJG5lOiBzZXNzaW9uVG9rZW4gfSxcbiAgfSk7XG59O1xuXG4vLyBIYW5kbGVzIGFueSBmb2xsb3d1cCBsb2dpY1xuUmVzdFdyaXRlLnByb3RvdHlwZS5oYW5kbGVGb2xsb3d1cCA9IGZ1bmN0aW9uKCkge1xuICBpZiAoXG4gICAgdGhpcy5zdG9yYWdlICYmXG4gICAgdGhpcy5zdG9yYWdlWydjbGVhclNlc3Npb25zJ10gJiZcbiAgICB0aGlzLmNvbmZpZy5yZXZva2VTZXNzaW9uT25QYXNzd29yZFJlc2V0XG4gICkge1xuICAgIHZhciBzZXNzaW9uUXVlcnkgPSB7XG4gICAgICB1c2VyOiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfVXNlcicsXG4gICAgICAgIG9iamVjdElkOiB0aGlzLm9iamVjdElkKCksXG4gICAgICB9LFxuICAgIH07XG4gICAgZGVsZXRlIHRoaXMuc3RvcmFnZVsnY2xlYXJTZXNzaW9ucyddO1xuICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgLmRlc3Ryb3koJ19TZXNzaW9uJywgc2Vzc2lvblF1ZXJ5KVxuICAgICAgLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydnZW5lcmF0ZU5ld1Nlc3Npb24nXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ2dlbmVyYXRlTmV3U2Vzc2lvbiddO1xuICAgIHJldHVybiB0aGlzLmNyZWF0ZVNlc3Npb25Ub2tlbigpLnRoZW4odGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpKTtcbiAgfVxuXG4gIGlmICh0aGlzLnN0b3JhZ2UgJiYgdGhpcy5zdG9yYWdlWydzZW5kVmVyaWZpY2F0aW9uRW1haWwnXSkge1xuICAgIGRlbGV0ZSB0aGlzLnN0b3JhZ2VbJ3NlbmRWZXJpZmljYXRpb25FbWFpbCddO1xuICAgIC8vIEZpcmUgYW5kIGZvcmdldCFcbiAgICB0aGlzLmNvbmZpZy51c2VyQ29udHJvbGxlci5zZW5kVmVyaWZpY2F0aW9uRW1haWwodGhpcy5kYXRhKTtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVGb2xsb3d1cC5iaW5kKHRoaXMpO1xuICB9XG59O1xuXG4vLyBIYW5kbGVzIHRoZSBfU2Vzc2lvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIF9TZXNzaW9uIG9iamVjdC5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlU2Vzc2lvbiA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5yZXNwb25zZSB8fCB0aGlzLmNsYXNzTmFtZSAhPT0gJ19TZXNzaW9uJykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5hdXRoLnVzZXIgJiYgIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTixcbiAgICAgICdTZXNzaW9uIHRva2VuIHJlcXVpcmVkLidcbiAgICApO1xuICB9XG5cbiAgLy8gVE9ETzogVmVyaWZ5IHByb3BlciBlcnJvciB0byB0aHJvd1xuICBpZiAodGhpcy5kYXRhLkFDTCkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAnQ2Fubm90IHNldCAnICsgJ0FDTCBvbiBhIFNlc3Npb24uJ1xuICAgICk7XG4gIH1cblxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIGlmIChcbiAgICAgIHRoaXMuZGF0YS51c2VyICYmXG4gICAgICAhdGhpcy5hdXRoLmlzTWFzdGVyICYmXG4gICAgICB0aGlzLmRhdGEudXNlci5vYmplY3RJZCAhPSB0aGlzLmF1dGgudXNlci5pZFxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5kYXRhLmluc3RhbGxhdGlvbklkKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfSBlbHNlIGlmICh0aGlzLmRhdGEuc2Vzc2lvblRva2VuKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCF0aGlzLnF1ZXJ5ICYmICF0aGlzLmF1dGguaXNNYXN0ZXIpIHtcbiAgICBjb25zdCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEgPSB7fTtcbiAgICBmb3IgKHZhciBrZXkgaW4gdGhpcy5kYXRhKSB7XG4gICAgICBpZiAoa2V5ID09PSAnb2JqZWN0SWQnIHx8IGtleSA9PT0gJ3VzZXInKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgYWRkaXRpb25hbFNlc3Npb25EYXRhW2tleV0gPSB0aGlzLmRhdGFba2V5XTtcbiAgICB9XG5cbiAgICBjb25zdCB7IHNlc3Npb25EYXRhLCBjcmVhdGVTZXNzaW9uIH0gPSBBdXRoLmNyZWF0ZVNlc3Npb24odGhpcy5jb25maWcsIHtcbiAgICAgIHVzZXJJZDogdGhpcy5hdXRoLnVzZXIuaWQsXG4gICAgICBjcmVhdGVkV2l0aDoge1xuICAgICAgICBhY3Rpb246ICdjcmVhdGUnLFxuICAgICAgfSxcbiAgICAgIGFkZGl0aW9uYWxTZXNzaW9uRGF0YSxcbiAgICB9KTtcblxuICAgIHJldHVybiBjcmVhdGVTZXNzaW9uKCkudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIGlmICghcmVzdWx0cy5yZXNwb25zZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICdFcnJvciBjcmVhdGluZyBzZXNzaW9uLidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHNlc3Npb25EYXRhWydvYmplY3RJZCddID0gcmVzdWx0cy5yZXNwb25zZVsnb2JqZWN0SWQnXTtcbiAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgIHN0YXR1czogMjAxLFxuICAgICAgICBsb2NhdGlvbjogcmVzdWx0cy5sb2NhdGlvbixcbiAgICAgICAgcmVzcG9uc2U6IHNlc3Npb25EYXRhLFxuICAgICAgfTtcbiAgICB9KTtcbiAgfVxufTtcblxuLy8gSGFuZGxlcyB0aGUgX0luc3RhbGxhdGlvbiBjbGFzcyBzcGVjaWFsbmVzcy5cbi8vIERvZXMgbm90aGluZyBpZiB0aGlzIGlzbid0IGFuIGluc3RhbGxhdGlvbiBvYmplY3QuXG4vLyBJZiBhbiBpbnN0YWxsYXRpb24gaXMgZm91bmQsIHRoaXMgY2FuIG11dGF0ZSB0aGlzLnF1ZXJ5IGFuZCB0dXJuIGEgY3JlYXRlXG4vLyBpbnRvIGFuIHVwZGF0ZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciB3aGVuIHdlJ3JlIGRvbmUgaWYgaXQgY2FuJ3QgZmluaXNoIHRoaXMgdGljay5cblJlc3RXcml0ZS5wcm90b3R5cGUuaGFuZGxlSW5zdGFsbGF0aW9uID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlIHx8IHRoaXMuY2xhc3NOYW1lICE9PSAnX0luc3RhbGxhdGlvbicpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoXG4gICAgIXRoaXMucXVlcnkgJiZcbiAgICAhdGhpcy5kYXRhLmRldmljZVRva2VuICYmXG4gICAgIXRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICF0aGlzLmF1dGguaW5zdGFsbGF0aW9uSWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgMTM1LFxuICAgICAgJ2F0IGxlYXN0IG9uZSBJRCBmaWVsZCAoZGV2aWNlVG9rZW4sIGluc3RhbGxhdGlvbklkKSAnICtcbiAgICAgICAgJ211c3QgYmUgc3BlY2lmaWVkIGluIHRoaXMgb3BlcmF0aW9uJ1xuICAgICk7XG4gIH1cblxuICAvLyBJZiB0aGUgZGV2aWNlIHRva2VuIGlzIDY0IGNoYXJhY3RlcnMgbG9uZywgd2UgYXNzdW1lIGl0IGlzIGZvciBpT1NcbiAgLy8gYW5kIGxvd2VyY2FzZSBpdC5cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJiB0aGlzLmRhdGEuZGV2aWNlVG9rZW4ubGVuZ3RoID09IDY0KSB7XG4gICAgdGhpcy5kYXRhLmRldmljZVRva2VuID0gdGhpcy5kYXRhLmRldmljZVRva2VuLnRvTG93ZXJDYXNlKCk7XG4gIH1cblxuICAvLyBXZSBsb3dlcmNhc2UgdGhlIGluc3RhbGxhdGlvbklkIGlmIHByZXNlbnRcbiAgaWYgKHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCkge1xuICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCA9IHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZC50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgbGV0IGluc3RhbGxhdGlvbklkID0gdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkO1xuXG4gIC8vIElmIGRhdGEuaW5zdGFsbGF0aW9uSWQgaXMgbm90IHNldCBhbmQgd2UncmUgbm90IG1hc3Rlciwgd2UgY2FuIGxvb2t1cCBpbiBhdXRoXG4gIGlmICghaW5zdGFsbGF0aW9uSWQgJiYgIXRoaXMuYXV0aC5pc01hc3Rlcikge1xuICAgIGluc3RhbGxhdGlvbklkID0gdGhpcy5hdXRoLmluc3RhbGxhdGlvbklkO1xuICB9XG5cbiAgaWYgKGluc3RhbGxhdGlvbklkKSB7XG4gICAgaW5zdGFsbGF0aW9uSWQgPSBpbnN0YWxsYXRpb25JZC50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgLy8gVXBkYXRpbmcgX0luc3RhbGxhdGlvbiBidXQgbm90IHVwZGF0aW5nIGFueXRoaW5nIGNyaXRpY2FsXG4gIGlmIChcbiAgICB0aGlzLnF1ZXJ5ICYmXG4gICAgIXRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICFpbnN0YWxsYXRpb25JZCAmJlxuICAgICF0aGlzLmRhdGEuZGV2aWNlVHlwZVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4gIHZhciBpZE1hdGNoOyAvLyBXaWxsIGJlIGEgbWF0Y2ggb24gZWl0aGVyIG9iamVjdElkIG9yIGluc3RhbGxhdGlvbklkXG4gIHZhciBvYmplY3RJZE1hdGNoO1xuICB2YXIgaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgdmFyIGRldmljZVRva2VuTWF0Y2hlcyA9IFtdO1xuXG4gIC8vIEluc3RlYWQgb2YgaXNzdWluZyAzIHJlYWRzLCBsZXQncyBkbyBpdCB3aXRoIG9uZSBPUi5cbiAgY29uc3Qgb3JRdWVyaWVzID0gW107XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBvYmplY3RJZDogdGhpcy5xdWVyeS5vYmplY3RJZCxcbiAgICB9KTtcbiAgfVxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBvclF1ZXJpZXMucHVzaCh7XG4gICAgICBpbnN0YWxsYXRpb25JZDogaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG4gIH1cbiAgaWYgKHRoaXMuZGF0YS5kZXZpY2VUb2tlbikge1xuICAgIG9yUXVlcmllcy5wdXNoKHsgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbiB9KTtcbiAgfVxuXG4gIGlmIChvclF1ZXJpZXMubGVuZ3RoID09IDApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBwcm9taXNlID0gcHJvbWlzZVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZS5maW5kKFxuICAgICAgICAnX0luc3RhbGxhdGlvbicsXG4gICAgICAgIHtcbiAgICAgICAgICAkb3I6IG9yUXVlcmllcyxcbiAgICAgICAgfSxcbiAgICAgICAge31cbiAgICAgICk7XG4gICAgfSlcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIHJlc3VsdHMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdGhpcy5xdWVyeSAmJlxuICAgICAgICAgIHRoaXMucXVlcnkub2JqZWN0SWQgJiZcbiAgICAgICAgICByZXN1bHQub2JqZWN0SWQgPT0gdGhpcy5xdWVyeS5vYmplY3RJZFxuICAgICAgICApIHtcbiAgICAgICAgICBvYmplY3RJZE1hdGNoID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXN1bHQuaW5zdGFsbGF0aW9uSWQgPT0gaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICBpbnN0YWxsYXRpb25JZE1hdGNoID0gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChyZXN1bHQuZGV2aWNlVG9rZW4gPT0gdGhpcy5kYXRhLmRldmljZVRva2VuKSB7XG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLnB1c2gocmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIC8vIFNhbml0eSBjaGVja3Mgd2hlbiBydW5uaW5nIGEgcXVlcnlcbiAgICAgIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICAgICAgaWYgKCFvYmplY3RJZE1hdGNoKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCxcbiAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kIGZvciB1cGRhdGUuJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5pbnN0YWxsYXRpb25JZCAmJlxuICAgICAgICAgIG9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWQgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQgIT09IG9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTM2LFxuICAgICAgICAgICAgJ2luc3RhbGxhdGlvbklkIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgIG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVG9rZW4gIT09IG9iamVjdElkTWF0Y2guZGV2aWNlVG9rZW4gJiZcbiAgICAgICAgICAhdGhpcy5kYXRhLmluc3RhbGxhdGlvbklkICYmXG4gICAgICAgICAgIW9iamVjdElkTWF0Y2guaW5zdGFsbGF0aW9uSWRcbiAgICAgICAgKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgMTM2LFxuICAgICAgICAgICAgJ2RldmljZVRva2VuIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUeXBlICYmXG4gICAgICAgICAgdGhpcy5kYXRhLmRldmljZVR5cGUgJiZcbiAgICAgICAgICB0aGlzLmRhdGEuZGV2aWNlVHlwZSAhPT0gb2JqZWN0SWRNYXRjaC5kZXZpY2VUeXBlXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIDEzNixcbiAgICAgICAgICAgICdkZXZpY2VUeXBlIG1heSBub3QgYmUgY2hhbmdlZCBpbiB0aGlzICcgKyAnb3BlcmF0aW9uJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMucXVlcnkgJiYgdGhpcy5xdWVyeS5vYmplY3RJZCAmJiBvYmplY3RJZE1hdGNoKSB7XG4gICAgICAgIGlkTWF0Y2ggPSBvYmplY3RJZE1hdGNoO1xuICAgICAgfVxuXG4gICAgICBpZiAoaW5zdGFsbGF0aW9uSWQgJiYgaW5zdGFsbGF0aW9uSWRNYXRjaCkge1xuICAgICAgICBpZE1hdGNoID0gaW5zdGFsbGF0aW9uSWRNYXRjaDtcbiAgICAgIH1cbiAgICAgIC8vIG5lZWQgdG8gc3BlY2lmeSBkZXZpY2VUeXBlIG9ubHkgaWYgaXQncyBuZXdcbiAgICAgIGlmICghdGhpcy5xdWVyeSAmJiAhdGhpcy5kYXRhLmRldmljZVR5cGUgJiYgIWlkTWF0Y2gpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIDEzNSxcbiAgICAgICAgICAnZGV2aWNlVHlwZSBtdXN0IGJlIHNwZWNpZmllZCBpbiB0aGlzIG9wZXJhdGlvbidcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC50aGVuKCgpID0+IHtcbiAgICAgIGlmICghaWRNYXRjaCkge1xuICAgICAgICBpZiAoIWRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgZGV2aWNlVG9rZW5NYXRjaGVzLmxlbmd0aCA9PSAxICYmXG4gICAgICAgICAgKCFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ10gfHwgIWluc3RhbGxhdGlvbklkKVxuICAgICAgICApIHtcbiAgICAgICAgICAvLyBTaW5nbGUgbWF0Y2ggb24gZGV2aWNlIHRva2VuIGJ1dCBub25lIG9uIGluc3RhbGxhdGlvbklkLCBhbmQgZWl0aGVyXG4gICAgICAgICAgLy8gdGhlIHBhc3NlZCBvYmplY3Qgb3IgdGhlIG1hdGNoIGlzIG1pc3NpbmcgYW4gaW5zdGFsbGF0aW9uSWQsIHNvIHdlXG4gICAgICAgICAgLy8gY2FuIGp1c3QgcmV0dXJuIHRoZSBtYXRjaC5cbiAgICAgICAgICByZXR1cm4gZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydvYmplY3RJZCddO1xuICAgICAgICB9IGVsc2UgaWYgKCF0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAxMzIsXG4gICAgICAgICAgICAnTXVzdCBzcGVjaWZ5IGluc3RhbGxhdGlvbklkIHdoZW4gZGV2aWNlVG9rZW4gJyArXG4gICAgICAgICAgICAgICdtYXRjaGVzIG11bHRpcGxlIEluc3RhbGxhdGlvbiBvYmplY3RzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gTXVsdGlwbGUgZGV2aWNlIHRva2VuIG1hdGNoZXMgYW5kIHdlIHNwZWNpZmllZCBhbiBpbnN0YWxsYXRpb24gSUQsXG4gICAgICAgICAgLy8gb3IgYSBzaW5nbGUgbWF0Y2ggd2hlcmUgYm90aCB0aGUgcGFzc2VkIGFuZCBtYXRjaGluZyBvYmplY3RzIGhhdmVcbiAgICAgICAgICAvLyBhbiBpbnN0YWxsYXRpb24gSUQuIFRyeSBjbGVhbmluZyBvdXQgb2xkIGluc3RhbGxhdGlvbnMgdGhhdCBtYXRjaFxuICAgICAgICAgIC8vIHRoZSBkZXZpY2VUb2tlbiwgYW5kIHJldHVybiBuaWwgdG8gc2lnbmFsIHRoYXQgYSBuZXcgb2JqZWN0IHNob3VsZFxuICAgICAgICAgIC8vIGJlIGNyZWF0ZWQuXG4gICAgICAgICAgdmFyIGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgZGV2aWNlVG9rZW46IHRoaXMuZGF0YS5kZXZpY2VUb2tlbixcbiAgICAgICAgICAgIGluc3RhbGxhdGlvbklkOiB7XG4gICAgICAgICAgICAgICRuZTogaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH07XG4gICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICBkZWxRdWVyeVsnYXBwSWRlbnRpZmllciddID0gdGhpcy5kYXRhLmFwcElkZW50aWZpZXI7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlLmRlc3Ryb3koJ19JbnN0YWxsYXRpb24nLCBkZWxRdWVyeSkuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkLlxuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyByZXRocm93IHRoZSBlcnJvclxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGRldmljZVRva2VuTWF0Y2hlcy5sZW5ndGggPT0gMSAmJlxuICAgICAgICAgICFkZXZpY2VUb2tlbk1hdGNoZXNbMF1bJ2luc3RhbGxhdGlvbklkJ11cbiAgICAgICAgKSB7XG4gICAgICAgICAgLy8gRXhhY3RseSBvbmUgZGV2aWNlIHRva2VuIG1hdGNoIGFuZCBpdCBkb2Vzbid0IGhhdmUgYW4gaW5zdGFsbGF0aW9uXG4gICAgICAgICAgLy8gSUQuIFRoaXMgaXMgdGhlIG9uZSBjYXNlIHdoZXJlIHdlIHdhbnQgdG8gbWVyZ2Ugd2l0aCB0aGUgZXhpc3RpbmdcbiAgICAgICAgICAvLyBvYmplY3QuXG4gICAgICAgICAgY29uc3QgZGVsUXVlcnkgPSB7IG9iamVjdElkOiBpZE1hdGNoLm9iamVjdElkIH07XG4gICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgICAuZGVzdHJveSgnX0luc3RhbGxhdGlvbicsIGRlbFF1ZXJ5KVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gZGV2aWNlVG9rZW5NYXRjaGVzWzBdWydvYmplY3RJZCddO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICBpZiAoZXJyLmNvZGUgPT0gUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCkge1xuICAgICAgICAgICAgICAgIC8vIG5vIGRlbGV0aW9ucyB3ZXJlIG1hZGUuIENhbiBiZSBpZ25vcmVkXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIC8vIHJldGhyb3cgdGhlIGVycm9yXG4gICAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHRoaXMuZGF0YS5kZXZpY2VUb2tlbiAmJlxuICAgICAgICAgICAgaWRNYXRjaC5kZXZpY2VUb2tlbiAhPSB0aGlzLmRhdGEuZGV2aWNlVG9rZW5cbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIC8vIFdlJ3JlIHNldHRpbmcgdGhlIGRldmljZSB0b2tlbiBvbiBhbiBleGlzdGluZyBpbnN0YWxsYXRpb24sIHNvXG4gICAgICAgICAgICAvLyB3ZSBzaG91bGQgdHJ5IGNsZWFuaW5nIG91dCBvbGQgaW5zdGFsbGF0aW9ucyB0aGF0IG1hdGNoIHRoaXNcbiAgICAgICAgICAgIC8vIGRldmljZSB0b2tlbi5cbiAgICAgICAgICAgIGNvbnN0IGRlbFF1ZXJ5ID0ge1xuICAgICAgICAgICAgICBkZXZpY2VUb2tlbjogdGhpcy5kYXRhLmRldmljZVRva2VuLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIC8vIFdlIGhhdmUgYSB1bmlxdWUgaW5zdGFsbCBJZCwgdXNlIHRoYXQgdG8gcHJlc2VydmVcbiAgICAgICAgICAgIC8vIHRoZSBpbnRlcmVzdGluZyBpbnN0YWxsYXRpb25cbiAgICAgICAgICAgIGlmICh0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQpIHtcbiAgICAgICAgICAgICAgZGVsUXVlcnlbJ2luc3RhbGxhdGlvbklkJ10gPSB7XG4gICAgICAgICAgICAgICAgJG5lOiB0aGlzLmRhdGEuaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkICYmXG4gICAgICAgICAgICAgIHRoaXMuZGF0YS5vYmplY3RJZCAmJlxuICAgICAgICAgICAgICBpZE1hdGNoLm9iamVjdElkID09IHRoaXMuZGF0YS5vYmplY3RJZFxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIHdlIHBhc3NlZCBhbiBvYmplY3RJZCwgcHJlc2VydmUgdGhhdCBpbnN0YWxhdGlvblxuICAgICAgICAgICAgICBkZWxRdWVyeVsnb2JqZWN0SWQnXSA9IHtcbiAgICAgICAgICAgICAgICAkbmU6IGlkTWF0Y2gub2JqZWN0SWQsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBXaGF0IHRvIGRvIGhlcmU/IGNhbid0IHJlYWxseSBjbGVhbiB1cCBldmVyeXRoaW5nLi4uXG4gICAgICAgICAgICAgIHJldHVybiBpZE1hdGNoLm9iamVjdElkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHRoaXMuZGF0YS5hcHBJZGVudGlmaWVyKSB7XG4gICAgICAgICAgICAgIGRlbFF1ZXJ5WydhcHBJZGVudGlmaWVyJ10gPSB0aGlzLmRhdGEuYXBwSWRlbnRpZmllcjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMuY29uZmlnLmRhdGFiYXNlXG4gICAgICAgICAgICAgIC5kZXN0cm95KCdfSW5zdGFsbGF0aW9uJywgZGVsUXVlcnkpXG4gICAgICAgICAgICAgIC5jYXRjaChlcnIgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChlcnIuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgICAgICAgICAvLyBubyBkZWxldGlvbnMgd2VyZSBtYWRlLiBDYW4gYmUgaWdub3JlZC5cbiAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgLy8gcmV0aHJvdyB0aGUgZXJyb3JcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBJbiBub24tbWVyZ2Ugc2NlbmFyaW9zLCBqdXN0IHJldHVybiB0aGUgaW5zdGFsbGF0aW9uIG1hdGNoIGlkXG4gICAgICAgICAgcmV0dXJuIGlkTWF0Y2gub2JqZWN0SWQ7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KVxuICAgIC50aGVuKG9iaklkID0+IHtcbiAgICAgIGlmIChvYmpJZCkge1xuICAgICAgICB0aGlzLnF1ZXJ5ID0geyBvYmplY3RJZDogb2JqSWQgfTtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgZGVsZXRlIHRoaXMuZGF0YS5jcmVhdGVkQXQ7XG4gICAgICB9XG4gICAgICAvLyBUT0RPOiBWYWxpZGF0ZSBvcHMgKGFkZC9yZW1vdmUgb24gY2hhbm5lbHMsICRpbmMgb24gYmFkZ2UsIGV0Yy4pXG4gICAgfSk7XG4gIHJldHVybiBwcm9taXNlO1xufTtcblxuLy8gSWYgd2Ugc2hvcnQtY2lyY3V0ZWQgdGhlIG9iamVjdCByZXNwb25zZSAtIHRoZW4gd2UgbmVlZCB0byBtYWtlIHN1cmUgd2UgZXhwYW5kIGFsbCB0aGUgZmlsZXMsXG4vLyBzaW5jZSB0aGlzIG1pZ2h0IG5vdCBoYXZlIGEgcXVlcnksIG1lYW5pbmcgaXQgd29uJ3QgcmV0dXJuIHRoZSBmdWxsIHJlc3VsdCBiYWNrLlxuLy8gVE9ETzogKG5sdXRzZW5rbykgVGhpcyBzaG91bGQgZGllIHdoZW4gd2UgbW92ZSB0byBwZXItY2xhc3MgYmFzZWQgY29udHJvbGxlcnMgb24gX1Nlc3Npb24vX1VzZXJcblJlc3RXcml0ZS5wcm90b3R5cGUuZXhwYW5kRmlsZXNGb3JFeGlzdGluZ09iamVjdHMgPSBmdW5jdGlvbigpIHtcbiAgLy8gQ2hlY2sgd2hldGhlciB3ZSBoYXZlIGEgc2hvcnQtY2lyY3VpdGVkIHJlc3BvbnNlIC0gb25seSB0aGVuIHJ1biBleHBhbnNpb24uXG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UpIHtcbiAgICB0aGlzLmNvbmZpZy5maWxlc0NvbnRyb2xsZXIuZXhwYW5kRmlsZXNJbk9iamVjdChcbiAgICAgIHRoaXMuY29uZmlnLFxuICAgICAgdGhpcy5yZXNwb25zZS5yZXNwb25zZVxuICAgICk7XG4gIH1cbn07XG5cblJlc3RXcml0ZS5wcm90b3R5cGUucnVuRGF0YWJhc2VPcGVyYXRpb24gPSBmdW5jdGlvbigpIHtcbiAgaWYgKHRoaXMucmVzcG9uc2UpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAodGhpcy5jbGFzc05hbWUgPT09ICdfUm9sZScpIHtcbiAgICB0aGlzLmNvbmZpZy5jYWNoZUNvbnRyb2xsZXIucm9sZS5jbGVhcigpO1xuICB9XG5cbiAgaWYgKFxuICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgdGhpcy5xdWVyeSAmJlxuICAgIHRoaXMuYXV0aC5pc1VuYXV0aGVudGljYXRlZCgpXG4gICkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLlNFU1NJT05fTUlTU0lORyxcbiAgICAgIGBDYW5ub3QgbW9kaWZ5IHVzZXIgJHt0aGlzLnF1ZXJ5Lm9iamVjdElkfS5gXG4gICAgKTtcbiAgfVxuXG4gIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Qcm9kdWN0JyAmJiB0aGlzLmRhdGEuZG93bmxvYWQpIHtcbiAgICB0aGlzLmRhdGEuZG93bmxvYWROYW1lID0gdGhpcy5kYXRhLmRvd25sb2FkLm5hbWU7XG4gIH1cblxuICAvLyBUT0RPOiBBZGQgYmV0dGVyIGRldGVjdGlvbiBmb3IgQUNMLCBlbnN1cmluZyBhIHVzZXIgY2FuJ3QgYmUgbG9ja2VkIGZyb21cbiAgLy8gICAgICAgdGhlaXIgb3duIHVzZXIgcmVjb3JkLlxuICBpZiAodGhpcy5kYXRhLkFDTCAmJiB0aGlzLmRhdGEuQUNMWycqdW5yZXNvbHZlZCddKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfQUNMLCAnSW52YWxpZCBBQ0wuJyk7XG4gIH1cblxuICBpZiAodGhpcy5xdWVyeSkge1xuICAgIC8vIEZvcmNlIHRoZSB1c2VyIHRvIG5vdCBsb2Nrb3V0XG4gICAgLy8gTWF0Y2hlZCB3aXRoIHBhcnNlLmNvbVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuQUNMICYmXG4gICAgICB0aGlzLmF1dGguaXNNYXN0ZXIgIT09IHRydWVcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5BQ0xbdGhpcy5xdWVyeS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgfVxuICAgIC8vIHVwZGF0ZSBwYXNzd29yZCB0aW1lc3RhbXAgaWYgdXNlciBwYXNzd29yZCBpcyBiZWluZyBjaGFuZ2VkXG4gICAgaWYgKFxuICAgICAgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicgJiZcbiAgICAgIHRoaXMuZGF0YS5faGFzaGVkX3Bhc3N3b3JkICYmXG4gICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeSAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kubWF4UGFzc3dvcmRBZ2VcbiAgICApIHtcbiAgICAgIHRoaXMuZGF0YS5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IFBhcnNlLl9lbmNvZGUobmV3IERhdGUoKSk7XG4gICAgfVxuICAgIC8vIElnbm9yZSBjcmVhdGVkQXQgd2hlbiB1cGRhdGVcbiAgICBkZWxldGUgdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgIGxldCBkZWZlciA9IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIC8vIGlmIHBhc3N3b3JkIGhpc3RvcnkgaXMgZW5hYmxlZCB0aGVuIHNhdmUgdGhlIGN1cnJlbnQgcGFzc3dvcmQgdG8gaGlzdG9yeVxuICAgIGlmIChcbiAgICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInICYmXG4gICAgICB0aGlzLmRhdGEuX2hhc2hlZF9wYXNzd29yZCAmJlxuICAgICAgdGhpcy5jb25maWcucGFzc3dvcmRQb2xpY3kgJiZcbiAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeVxuICAgICkge1xuICAgICAgZGVmZXIgPSB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAuZmluZChcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHsgb2JqZWN0SWQ6IHRoaXMub2JqZWN0SWQoKSB9LFxuICAgICAgICAgIHsga2V5czogWydfcGFzc3dvcmRfaGlzdG9yeScsICdfaGFzaGVkX3Bhc3N3b3JkJ10gfVxuICAgICAgICApXG4gICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgIGlmIChyZXN1bHRzLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHVzZXIgPSByZXN1bHRzWzBdO1xuICAgICAgICAgIGxldCBvbGRQYXNzd29yZHMgPSBbXTtcbiAgICAgICAgICBpZiAodXNlci5fcGFzc3dvcmRfaGlzdG9yeSkge1xuICAgICAgICAgICAgb2xkUGFzc3dvcmRzID0gXy50YWtlKFxuICAgICAgICAgICAgICB1c2VyLl9wYXNzd29yZF9oaXN0b3J5LFxuICAgICAgICAgICAgICB0aGlzLmNvbmZpZy5wYXNzd29yZFBvbGljeS5tYXhQYXNzd29yZEhpc3RvcnlcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vbi0xIHBhc3N3b3JkcyBnbyBpbnRvIGhpc3RvcnkgaW5jbHVkaW5nIGxhc3QgcGFzc3dvcmRcbiAgICAgICAgICB3aGlsZSAoXG4gICAgICAgICAgICBvbGRQYXNzd29yZHMubGVuZ3RoID5cbiAgICAgICAgICAgIE1hdGgubWF4KDAsIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkSGlzdG9yeSAtIDIpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBvbGRQYXNzd29yZHMuc2hpZnQoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2xkUGFzc3dvcmRzLnB1c2godXNlci5wYXNzd29yZCk7XG4gICAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9oaXN0b3J5ID0gb2xkUGFzc3dvcmRzO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZGVmZXIudGhlbigoKSA9PiB7XG4gICAgICAvLyBSdW4gYW4gdXBkYXRlXG4gICAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgICAgLnVwZGF0ZSh0aGlzLmNsYXNzTmFtZSwgdGhpcy5xdWVyeSwgdGhpcy5kYXRhLCB0aGlzLnJ1bk9wdGlvbnMpXG4gICAgICAgIC50aGVuKHJlc3BvbnNlID0+IHtcbiAgICAgICAgICByZXNwb25zZS51cGRhdGVkQXQgPSB0aGlzLnVwZGF0ZWRBdDtcbiAgICAgICAgICB0aGlzLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhKHJlc3BvbnNlLCB0aGlzLmRhdGEpO1xuICAgICAgICAgIHRoaXMucmVzcG9uc2UgPSB7IHJlc3BvbnNlIH07XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIFNldCB0aGUgZGVmYXVsdCBBQ0wgYW5kIHBhc3N3b3JkIHRpbWVzdGFtcCBmb3IgdGhlIG5ldyBfVXNlclxuICAgIGlmICh0aGlzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgdmFyIEFDTCA9IHRoaXMuZGF0YS5BQ0w7XG4gICAgICAvLyBkZWZhdWx0IHB1YmxpYyByL3cgQUNMXG4gICAgICBpZiAoIUFDTCkge1xuICAgICAgICBBQ0wgPSB7fTtcbiAgICAgICAgQUNMWycqJ10gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiBmYWxzZSB9O1xuICAgICAgfVxuICAgICAgLy8gbWFrZSBzdXJlIHRoZSB1c2VyIGlzIG5vdCBsb2NrZWQgZG93blxuICAgICAgQUNMW3RoaXMuZGF0YS5vYmplY3RJZF0gPSB7IHJlYWQ6IHRydWUsIHdyaXRlOiB0cnVlIH07XG4gICAgICB0aGlzLmRhdGEuQUNMID0gQUNMO1xuICAgICAgLy8gcGFzc3dvcmQgdGltZXN0YW1wIHRvIGJlIHVzZWQgd2hlbiBwYXNzd29yZCBleHBpcnkgcG9saWN5IGlzIGVuZm9yY2VkXG4gICAgICBpZiAoXG4gICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5ICYmXG4gICAgICAgIHRoaXMuY29uZmlnLnBhc3N3b3JkUG9saWN5Lm1heFBhc3N3b3JkQWdlXG4gICAgICApIHtcbiAgICAgICAgdGhpcy5kYXRhLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0gUGFyc2UuX2VuY29kZShuZXcgRGF0ZSgpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSdW4gYSBjcmVhdGVcbiAgICByZXR1cm4gdGhpcy5jb25maWcuZGF0YWJhc2VcbiAgICAgIC5jcmVhdGUodGhpcy5jbGFzc05hbWUsIHRoaXMuZGF0YSwgdGhpcy5ydW5PcHRpb25zKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHRoaXMuY2xhc3NOYW1lICE9PSAnX1VzZXInIHx8XG4gICAgICAgICAgZXJyb3IuY29kZSAhPT0gUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUXVpY2sgY2hlY2ssIGlmIHdlIHdlcmUgYWJsZSB0byBpbmZlciB0aGUgZHVwbGljYXRlZCBmaWVsZCBuYW1lXG4gICAgICAgIGlmIChcbiAgICAgICAgICBlcnJvciAmJlxuICAgICAgICAgIGVycm9yLnVzZXJJbmZvICYmXG4gICAgICAgICAgZXJyb3IudXNlckluZm8uZHVwbGljYXRlZF9maWVsZCA9PT0gJ3VzZXJuYW1lJ1xuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5VU0VSTkFNRV9UQUtFTixcbiAgICAgICAgICAgICdBY2NvdW50IGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIHVzZXJuYW1lLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVycm9yICYmXG4gICAgICAgICAgZXJyb3IudXNlckluZm8gJiZcbiAgICAgICAgICBlcnJvci51c2VySW5mby5kdXBsaWNhdGVkX2ZpZWxkID09PSAnZW1haWwnXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkVNQUlMX1RBS0VOLFxuICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgZW1haWwgYWRkcmVzcy4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIElmIHRoaXMgd2FzIGEgZmFpbGVkIHVzZXIgY3JlYXRpb24gZHVlIHRvIHVzZXJuYW1lIG9yIGVtYWlsIGFscmVhZHkgdGFrZW4sIHdlIG5lZWQgdG9cbiAgICAgICAgLy8gY2hlY2sgd2hldGhlciBpdCB3YXMgdXNlcm5hbWUgb3IgZW1haWwgYW5kIHJldHVybiB0aGUgYXBwcm9wcmlhdGUgZXJyb3IuXG4gICAgICAgIC8vIEZhbGxiYWNrIHRvIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICAgICAgLy8gVE9ETzogU2VlIGlmIHdlIGNhbiBsYXRlciBkbyB0aGlzIHdpdGhvdXQgYWRkaXRpb25hbCBxdWVyaWVzIGJ5IHVzaW5nIG5hbWVkIGluZGV4ZXMuXG4gICAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5kYXRhYmFzZVxuICAgICAgICAgIC5maW5kKFxuICAgICAgICAgICAgdGhpcy5jbGFzc05hbWUsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHVzZXJuYW1lOiB0aGlzLmRhdGEudXNlcm5hbWUsXG4gICAgICAgICAgICAgIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgeyBsaW1pdDogMSB9XG4gICAgICAgICAgKVxuICAgICAgICAgIC50aGVuKHJlc3VsdHMgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuVVNFUk5BTUVfVEFLRU4sXG4gICAgICAgICAgICAgICAgJ0FjY291bnQgYWxyZWFkeSBleGlzdHMgZm9yIHRoaXMgdXNlcm5hbWUuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFiYXNlLmZpbmQoXG4gICAgICAgICAgICAgIHRoaXMuY2xhc3NOYW1lLFxuICAgICAgICAgICAgICB7IGVtYWlsOiB0aGlzLmRhdGEuZW1haWwsIG9iamVjdElkOiB7ICRuZTogdGhpcy5vYmplY3RJZCgpIH0gfSxcbiAgICAgICAgICAgICAgeyBsaW1pdDogMSB9XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5FTUFJTF9UQUtFTixcbiAgICAgICAgICAgICAgICAnQWNjb3VudCBhbHJlYWR5IGV4aXN0cyBmb3IgdGhpcyBlbWFpbCBhZGRyZXNzLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICAgICAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICByZXNwb25zZS5vYmplY3RJZCA9IHRoaXMuZGF0YS5vYmplY3RJZDtcbiAgICAgICAgcmVzcG9uc2UuY3JlYXRlZEF0ID0gdGhpcy5kYXRhLmNyZWF0ZWRBdDtcblxuICAgICAgICBpZiAodGhpcy5yZXNwb25zZVNob3VsZEhhdmVVc2VybmFtZSkge1xuICAgICAgICAgIHJlc3BvbnNlLnVzZXJuYW1lID0gdGhpcy5kYXRhLnVzZXJuYW1lO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuX3VwZGF0ZVJlc3BvbnNlV2l0aERhdGEocmVzcG9uc2UsIHRoaXMuZGF0YSk7XG4gICAgICAgIHRoaXMucmVzcG9uc2UgPSB7XG4gICAgICAgICAgc3RhdHVzOiAyMDEsXG4gICAgICAgICAgcmVzcG9uc2UsXG4gICAgICAgICAgbG9jYXRpb246IHRoaXMubG9jYXRpb24oKSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICB9XG59O1xuXG4vLyBSZXR1cm5zIG5vdGhpbmcgLSBkb2Vzbid0IHdhaXQgZm9yIHRoZSB0cmlnZ2VyLlxuUmVzdFdyaXRlLnByb3RvdHlwZS5ydW5BZnRlclNhdmVUcmlnZ2VyID0gZnVuY3Rpb24oKSB7XG4gIGlmICghdGhpcy5yZXNwb25zZSB8fCAhdGhpcy5yZXNwb25zZS5yZXNwb25zZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEF2b2lkIGRvaW5nIGFueSBzZXR1cCBmb3IgdHJpZ2dlcnMgaWYgdGhlcmUgaXMgbm8gJ2FmdGVyU2F2ZScgdHJpZ2dlciBmb3IgdGhpcyBjbGFzcy5cbiAgY29uc3QgaGFzQWZ0ZXJTYXZlSG9vayA9IHRyaWdnZXJzLnRyaWdnZXJFeGlzdHMoXG4gICAgdGhpcy5jbGFzc05hbWUsXG4gICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgIHRoaXMuY29uZmlnLmFwcGxpY2F0aW9uSWRcbiAgKTtcbiAgY29uc3QgaGFzTGl2ZVF1ZXJ5ID0gdGhpcy5jb25maWcubGl2ZVF1ZXJ5Q29udHJvbGxlci5oYXNMaXZlUXVlcnkoXG4gICAgdGhpcy5jbGFzc05hbWVcbiAgKTtcbiAgaWYgKCFoYXNBZnRlclNhdmVIb29rICYmICFoYXNMaXZlUXVlcnkpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cblxuICB2YXIgZXh0cmFEYXRhID0geyBjbGFzc05hbWU6IHRoaXMuY2xhc3NOYW1lIH07XG4gIGlmICh0aGlzLnF1ZXJ5ICYmIHRoaXMucXVlcnkub2JqZWN0SWQpIHtcbiAgICBleHRyYURhdGEub2JqZWN0SWQgPSB0aGlzLnF1ZXJ5Lm9iamVjdElkO1xuICB9XG5cbiAgLy8gQnVpbGQgdGhlIG9yaWdpbmFsIG9iamVjdCwgd2Ugb25seSBkbyB0aGlzIGZvciBhIHVwZGF0ZSB3cml0ZS5cbiAgbGV0IG9yaWdpbmFsT2JqZWN0O1xuICBpZiAodGhpcy5xdWVyeSAmJiB0aGlzLnF1ZXJ5Lm9iamVjdElkKSB7XG4gICAgb3JpZ2luYWxPYmplY3QgPSB0cmlnZ2Vycy5pbmZsYXRlKGV4dHJhRGF0YSwgdGhpcy5vcmlnaW5hbERhdGEpO1xuICB9XG5cbiAgLy8gQnVpbGQgdGhlIGluZmxhdGVkIG9iamVjdCwgZGlmZmVyZW50IGZyb20gYmVmb3JlU2F2ZSwgb3JpZ2luYWxEYXRhIGlzIG5vdCBlbXB0eVxuICAvLyBzaW5jZSBkZXZlbG9wZXJzIGNhbiBjaGFuZ2UgZGF0YSBpbiB0aGUgYmVmb3JlU2F2ZS5cbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRoaXMuYnVpbGRVcGRhdGVkT2JqZWN0KGV4dHJhRGF0YSk7XG4gIHVwZGF0ZWRPYmplY3QuX2hhbmRsZVNhdmVSZXNwb25zZShcbiAgICB0aGlzLnJlc3BvbnNlLnJlc3BvbnNlLFxuICAgIHRoaXMucmVzcG9uc2Uuc3RhdHVzIHx8IDIwMFxuICApO1xuXG4gIHRoaXMuY29uZmlnLmRhdGFiYXNlLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgIC8vIE5vdGlmaXkgTGl2ZVF1ZXJ5U2VydmVyIGlmIHBvc3NpYmxlXG4gICAgY29uc3QgcGVybXMgPSBzY2hlbWFDb250cm9sbGVyLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhcbiAgICAgIHVwZGF0ZWRPYmplY3QuY2xhc3NOYW1lXG4gICAgKTtcbiAgICB0aGlzLmNvbmZpZy5saXZlUXVlcnlDb250cm9sbGVyLm9uQWZ0ZXJTYXZlKFxuICAgICAgdXBkYXRlZE9iamVjdC5jbGFzc05hbWUsXG4gICAgICB1cGRhdGVkT2JqZWN0LFxuICAgICAgb3JpZ2luYWxPYmplY3QsXG4gICAgICBwZXJtc1xuICAgICk7XG4gIH0pO1xuXG4gIC8vIFJ1biBhZnRlclNhdmUgdHJpZ2dlclxuICByZXR1cm4gdHJpZ2dlcnNcbiAgICAubWF5YmVSdW5UcmlnZ2VyKFxuICAgICAgdHJpZ2dlcnMuVHlwZXMuYWZ0ZXJTYXZlLFxuICAgICAgdGhpcy5hdXRoLFxuICAgICAgdXBkYXRlZE9iamVjdCxcbiAgICAgIG9yaWdpbmFsT2JqZWN0LFxuICAgICAgdGhpcy5jb25maWcsXG4gICAgICB0aGlzLmNvbnRleHRcbiAgICApXG4gICAgLmNhdGNoKGZ1bmN0aW9uKGVycikge1xuICAgICAgbG9nZ2VyLndhcm4oJ2FmdGVyU2F2ZSBjYXVnaHQgYW4gZXJyb3InLCBlcnIpO1xuICAgIH0pO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZmlndXJlIG91dCB3aGF0IGxvY2F0aW9uIHRoaXMgb3BlcmF0aW9uIGhhcHBlbnMgYXQuXG5SZXN0V3JpdGUucHJvdG90eXBlLmxvY2F0aW9uID0gZnVuY3Rpb24oKSB7XG4gIHZhciBtaWRkbGUgPVxuICAgIHRoaXMuY2xhc3NOYW1lID09PSAnX1VzZXInID8gJy91c2Vycy8nIDogJy9jbGFzc2VzLycgKyB0aGlzLmNsYXNzTmFtZSArICcvJztcbiAgcmV0dXJuIHRoaXMuY29uZmlnLm1vdW50ICsgbWlkZGxlICsgdGhpcy5kYXRhLm9iamVjdElkO1xufTtcblxuLy8gQSBoZWxwZXIgdG8gZ2V0IHRoZSBvYmplY3QgaWQgZm9yIHRoaXMgb3BlcmF0aW9uLlxuLy8gQmVjYXVzZSBpdCBjb3VsZCBiZSBlaXRoZXIgb24gdGhlIHF1ZXJ5IG9yIG9uIHRoZSBkYXRhXG5SZXN0V3JpdGUucHJvdG90eXBlLm9iamVjdElkID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLmRhdGEub2JqZWN0SWQgfHwgdGhpcy5xdWVyeS5vYmplY3RJZDtcbn07XG5cbi8vIFJldHVybnMgYSBjb3B5IG9mIHRoZSBkYXRhIGFuZCBkZWxldGUgYmFkIGtleXMgKF9hdXRoX2RhdGEsIF9oYXNoZWRfcGFzc3dvcmQuLi4pXG5SZXN0V3JpdGUucHJvdG90eXBlLnNhbml0aXplZERhdGEgPSBmdW5jdGlvbigpIHtcbiAgY29uc3QgZGF0YSA9IE9iamVjdC5rZXlzKHRoaXMuZGF0YSkucmVkdWNlKChkYXRhLCBrZXkpID0+IHtcbiAgICAvLyBSZWdleHAgY29tZXMgZnJvbSBQYXJzZS5PYmplY3QucHJvdG90eXBlLnZhbGlkYXRlXG4gICAgaWYgKCEvXltBLVphLXpdWzAtOUEtWmEtel9dKiQvLnRlc3Qoa2V5KSkge1xuICAgICAgZGVsZXRlIGRhdGFba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGRhdGE7XG4gIH0sIGRlZXBjb3B5KHRoaXMuZGF0YSkpO1xuICByZXR1cm4gUGFyc2UuX2RlY29kZSh1bmRlZmluZWQsIGRhdGEpO1xufTtcblxuLy8gUmV0dXJucyBhbiB1cGRhdGVkIGNvcHkgb2YgdGhlIG9iamVjdFxuUmVzdFdyaXRlLnByb3RvdHlwZS5idWlsZFVwZGF0ZWRPYmplY3QgPSBmdW5jdGlvbihleHRyYURhdGEpIHtcbiAgY29uc3QgdXBkYXRlZE9iamVjdCA9IHRyaWdnZXJzLmluZmxhdGUoZXh0cmFEYXRhLCB0aGlzLm9yaWdpbmFsRGF0YSk7XG4gIE9iamVjdC5rZXlzKHRoaXMuZGF0YSkucmVkdWNlKGZ1bmN0aW9uKGRhdGEsIGtleSkge1xuICAgIGlmIChrZXkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgLy8gc3ViZG9jdW1lbnQga2V5IHdpdGggZG90IG5vdGF0aW9uICgneC55Jzp2ID0+ICd4Jzp7J3knOnZ9KVxuICAgICAgY29uc3Qgc3BsaXR0ZWRLZXkgPSBrZXkuc3BsaXQoJy4nKTtcbiAgICAgIGNvbnN0IHBhcmVudFByb3AgPSBzcGxpdHRlZEtleVswXTtcbiAgICAgIGxldCBwYXJlbnRWYWwgPSB1cGRhdGVkT2JqZWN0LmdldChwYXJlbnRQcm9wKTtcbiAgICAgIGlmICh0eXBlb2YgcGFyZW50VmFsICE9PSAnb2JqZWN0Jykge1xuICAgICAgICBwYXJlbnRWYWwgPSB7fTtcbiAgICAgIH1cbiAgICAgIHBhcmVudFZhbFtzcGxpdHRlZEtleVsxXV0gPSBkYXRhW2tleV07XG4gICAgICB1cGRhdGVkT2JqZWN0LnNldChwYXJlbnRQcm9wLCBwYXJlbnRWYWwpO1xuICAgICAgZGVsZXRlIGRhdGFba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIGRhdGE7XG4gIH0sIGRlZXBjb3B5KHRoaXMuZGF0YSkpO1xuXG4gIHVwZGF0ZWRPYmplY3Quc2V0KHRoaXMuc2FuaXRpemVkRGF0YSgpKTtcbiAgcmV0dXJuIHVwZGF0ZWRPYmplY3Q7XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLmNsZWFuVXNlckF1dGhEYXRhID0gZnVuY3Rpb24oKSB7XG4gIGlmICh0aGlzLnJlc3BvbnNlICYmIHRoaXMucmVzcG9uc2UucmVzcG9uc2UgJiYgdGhpcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBjb25zdCB1c2VyID0gdGhpcy5yZXNwb25zZS5yZXNwb25zZTtcbiAgICBpZiAodXNlci5hdXRoRGF0YSkge1xuICAgICAgT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICAgIGlmICh1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXSA9PT0gbnVsbCkge1xuICAgICAgICAgIGRlbGV0ZSB1c2VyLmF1dGhEYXRhW3Byb3ZpZGVyXTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBpZiAoT2JqZWN0LmtleXModXNlci5hdXRoRGF0YSkubGVuZ3RoID09IDApIHtcbiAgICAgICAgZGVsZXRlIHVzZXIuYXV0aERhdGE7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG5SZXN0V3JpdGUucHJvdG90eXBlLl91cGRhdGVSZXNwb25zZVdpdGhEYXRhID0gZnVuY3Rpb24ocmVzcG9uc2UsIGRhdGEpIHtcbiAgaWYgKF8uaXNFbXB0eSh0aGlzLnN0b3JhZ2UuZmllbGRzQ2hhbmdlZEJ5VHJpZ2dlcikpIHtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH1cbiAgY29uc3QgY2xpZW50U3VwcG9ydHNEZWxldGUgPSBDbGllbnRTREsuc3VwcG9ydHNGb3J3YXJkRGVsZXRlKHRoaXMuY2xpZW50U0RLKTtcbiAgdGhpcy5zdG9yYWdlLmZpZWxkc0NoYW5nZWRCeVRyaWdnZXIuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGNvbnN0IGRhdGFWYWx1ZSA9IGRhdGFbZmllbGROYW1lXTtcblxuICAgIGlmICghcmVzcG9uc2UuaGFzT3duUHJvcGVydHkoZmllbGROYW1lKSkge1xuICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICB9XG5cbiAgICAvLyBTdHJpcHMgb3BlcmF0aW9ucyBmcm9tIHJlc3BvbnNlc1xuICAgIGlmIChyZXNwb25zZVtmaWVsZE5hbWVdICYmIHJlc3BvbnNlW2ZpZWxkTmFtZV0uX19vcCkge1xuICAgICAgZGVsZXRlIHJlc3BvbnNlW2ZpZWxkTmFtZV07XG4gICAgICBpZiAoY2xpZW50U3VwcG9ydHNEZWxldGUgJiYgZGF0YVZhbHVlLl9fb3AgPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgcmVzcG9uc2VbZmllbGROYW1lXSA9IGRhdGFWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuICByZXR1cm4gcmVzcG9uc2U7XG59O1xuXG5leHBvcnQgZGVmYXVsdCBSZXN0V3JpdGU7XG5tb2R1bGUuZXhwb3J0cyA9IFJlc3RXcml0ZTtcbiJdfQ==