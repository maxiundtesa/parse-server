"use strict";

const cryptoUtils = require('./cryptoUtils');

const RestQuery = require('./RestQuery');

const Parse = require('parse/node'); // An Auth object tells you who is requesting something and whether
// the master key was used.
// userObject is a Parse.User and can be null if there's no user.


function Auth({
  config,
  cacheController = undefined,
  isMaster = false,
  isReadOnly = false,
  user,
  installationId
}) {
  this.config = config;
  this.cacheController = cacheController || config && config.cacheController;
  this.installationId = installationId;
  this.isMaster = isMaster;
  this.user = user;
  this.isReadOnly = isReadOnly; // Assuming a users roles won't change during a single request, we'll
  // only load them once.

  this.userRoles = [];
  this.fetchedRoles = false;
  this.rolePromise = null;
} // Whether this auth could possibly modify the given user id.
// It still could be forbidden via ACLs even if this returns true.


Auth.prototype.isUnauthenticated = function () {
  if (this.isMaster) {
    return false;
  }

  if (this.user) {
    return false;
  }

  return true;
}; // A helper to get a master-level Auth object


function master(config) {
  return new Auth({
    config,
    isMaster: true
  });
} // A helper to get a master-level Auth object


function readOnly(config) {
  return new Auth({
    config,
    isMaster: true,
    isReadOnly: true
  });
} // A helper to get a nobody-level Auth object


function nobody(config) {
  return new Auth({
    config,
    isMaster: false
  });
} // Returns a promise that resolves to an Auth object


const getAuthForSessionToken = async function ({
  config,
  cacheController,
  sessionToken,
  installationId
}) {
  cacheController = cacheController || config && config.cacheController;

  if (cacheController) {
    const userJSON = await cacheController.user.get(sessionToken);

    if (userJSON) {
      const cachedUser = Parse.Object.fromJSON(userJSON);
      return Promise.resolve(new Auth({
        config,
        cacheController,
        isMaster: false,
        installationId,
        user: cachedUser
      }));
    }
  }

  let results;

  if (config) {
    const restOptions = {
      limit: 1,
      include: 'user'
    };
    const query = new RestQuery(config, master(config), '_Session', {
      sessionToken
    }, restOptions);
    results = (await query.execute()).results;
  } else {
    results = (await new Parse.Query(Parse.Session).limit(1).include('user').equalTo('sessionToken', sessionToken).find({
      useMasterKey: true
    })).map(obj => obj.toJSON());
  }

  if (results.length !== 1 || !results[0]['user']) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Invalid session token');
  }

  const now = new Date(),
        expiresAt = results[0].expiresAt ? new Date(results[0].expiresAt.iso) : undefined;

  if (expiresAt < now) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Session token is expired.');
  }

  const obj = results[0]['user'];
  delete obj.password;
  obj['className'] = '_User';
  obj['sessionToken'] = sessionToken;

  if (cacheController) {
    cacheController.user.put(sessionToken, obj);
  }

  const userObject = Parse.Object.fromJSON(obj);
  return new Auth({
    config,
    cacheController,
    isMaster: false,
    installationId,
    user: userObject
  });
};

var getAuthForLegacySessionToken = function ({
  config,
  sessionToken,
  installationId
}) {
  var restOptions = {
    limit: 1
  };
  var query = new RestQuery(config, master(config), '_User', {
    sessionToken
  }, restOptions);
  return query.execute().then(response => {
    var results = response.results;

    if (results.length !== 1) {
      throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'invalid legacy session token');
    }

    const obj = results[0];
    obj.className = '_User';
    const userObject = Parse.Object.fromJSON(obj);
    return new Auth({
      config,
      isMaster: false,
      installationId,
      user: userObject
    });
  });
}; // Returns a promise that resolves to an array of role names


Auth.prototype.getUserRoles = function () {
  if (this.isMaster || !this.user) {
    return Promise.resolve([]);
  }

  if (this.fetchedRoles) {
    return Promise.resolve(this.userRoles);
  }

  if (this.rolePromise) {
    return this.rolePromise;
  }

  this.rolePromise = this._loadRoles();
  return this.rolePromise;
};

Auth.prototype.getRolesForUser = async function () {
  //Stack all Parse.Role
  const results = [];

  if (this.config) {
    const restWhere = {
      users: {
        __type: 'Pointer',
        className: '_User',
        objectId: this.user.id
      }
    };
    await new RestQuery(this.config, master(this.config), '_Role', restWhere, {}).each(result => results.push(result));
  } else {
    await new Parse.Query(Parse.Role).equalTo('users', this.user).each(result => results.push(result.toJSON()), {
      useMasterKey: true
    });
  }

  return results;
}; // Iterates through the role tree and compiles a user's roles


Auth.prototype._loadRoles = async function () {
  if (this.cacheController) {
    const cachedRoles = await this.cacheController.role.get(this.user.id);

    if (cachedRoles != null) {
      this.fetchedRoles = true;
      this.userRoles = cachedRoles;
      return cachedRoles;
    }
  } // First get the role ids this user is directly a member of


  const results = await this.getRolesForUser();

  if (!results.length) {
    this.userRoles = [];
    this.fetchedRoles = true;
    this.rolePromise = null;
    this.cacheRoles();
    return this.userRoles;
  }

  const rolesMap = results.reduce((m, r) => {
    m.names.push(r.name);
    m.ids.push(r.objectId);
    return m;
  }, {
    ids: [],
    names: []
  }); // run the recursive finding

  const roleNames = await this._getAllRolesNamesForRoleIds(rolesMap.ids, rolesMap.names);
  this.userRoles = roleNames.map(r => {
    return 'role:' + r;
  });
  this.fetchedRoles = true;
  this.rolePromise = null;
  this.cacheRoles();
  return this.userRoles;
};

Auth.prototype.cacheRoles = function () {
  if (!this.cacheController) {
    return false;
  }

  this.cacheController.role.put(this.user.id, Array(...this.userRoles));
  return true;
};

Auth.prototype.getRolesByIds = async function (ins) {
  const results = []; // Build an OR query across all parentRoles

  if (!this.config) {
    await new Parse.Query(Parse.Role).containedIn('roles', ins.map(id => {
      const role = new Parse.Object(Parse.Role);
      role.id = id;
      return role;
    })).each(result => results.push(result.toJSON()), {
      useMasterKey: true
    });
  } else {
    const roles = ins.map(id => {
      return {
        __type: 'Pointer',
        className: '_Role',
        objectId: id
      };
    });
    const restWhere = {
      roles: {
        $in: roles
      }
    };
    await new RestQuery(this.config, master(this.config), '_Role', restWhere, {}).each(result => results.push(result));
  }

  return results;
}; // Given a list of roleIds, find all the parent roles, returns a promise with all names


Auth.prototype._getAllRolesNamesForRoleIds = function (roleIDs, names = [], queriedRoles = {}) {
  const ins = roleIDs.filter(roleID => {
    const wasQueried = queriedRoles[roleID] !== true;
    queriedRoles[roleID] = true;
    return wasQueried;
  }); // all roles are accounted for, return the names

  if (ins.length == 0) {
    return Promise.resolve([...new Set(names)]);
  }

  return this.getRolesByIds(ins).then(results => {
    // Nothing found
    if (!results.length) {
      return Promise.resolve(names);
    } // Map the results with all Ids and names


    const resultMap = results.reduce((memo, role) => {
      memo.names.push(role.name);
      memo.ids.push(role.objectId);
      return memo;
    }, {
      ids: [],
      names: []
    }); // store the new found names

    names = names.concat(resultMap.names); // find the next ones, circular roles will be cut

    return this._getAllRolesNamesForRoleIds(resultMap.ids, names, queriedRoles);
  }).then(names => {
    return Promise.resolve([...new Set(names)]);
  });
};

const createSession = function (config, {
  userId,
  createdWith,
  installationId,
  additionalSessionData
}) {
  const token = 'r:' + cryptoUtils.newToken();
  const expiresAt = config.generateSessionExpiresAt();
  const sessionData = {
    sessionToken: token,
    user: {
      __type: 'Pointer',
      className: '_User',
      objectId: userId
    },
    createdWith,
    restricted: false,
    expiresAt: Parse._encode(expiresAt)
  };

  if (installationId) {
    sessionData.installationId = installationId;
  }

  Object.assign(sessionData, additionalSessionData); // We need to import RestWrite at this point for the cyclic dependency it has to it

  const RestWrite = require('./RestWrite');

  return {
    sessionData,
    createSession: () => new RestWrite(config, master(config), '_Session', null, sessionData).execute()
  };
};

module.exports = {
  Auth,
  master,
  nobody,
  readOnly,
  getAuthForSessionToken,
  getAuthForLegacySessionToken,
  createSession
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9BdXRoLmpzIl0sIm5hbWVzIjpbImNyeXB0b1V0aWxzIiwicmVxdWlyZSIsIlJlc3RRdWVyeSIsIlBhcnNlIiwiQXV0aCIsImNvbmZpZyIsImNhY2hlQ29udHJvbGxlciIsInVuZGVmaW5lZCIsImlzTWFzdGVyIiwiaXNSZWFkT25seSIsInVzZXIiLCJpbnN0YWxsYXRpb25JZCIsInVzZXJSb2xlcyIsImZldGNoZWRSb2xlcyIsInJvbGVQcm9taXNlIiwicHJvdG90eXBlIiwiaXNVbmF1dGhlbnRpY2F0ZWQiLCJtYXN0ZXIiLCJyZWFkT25seSIsIm5vYm9keSIsImdldEF1dGhGb3JTZXNzaW9uVG9rZW4iLCJzZXNzaW9uVG9rZW4iLCJ1c2VySlNPTiIsImdldCIsImNhY2hlZFVzZXIiLCJPYmplY3QiLCJmcm9tSlNPTiIsIlByb21pc2UiLCJyZXNvbHZlIiwicmVzdWx0cyIsInJlc3RPcHRpb25zIiwibGltaXQiLCJpbmNsdWRlIiwicXVlcnkiLCJleGVjdXRlIiwiUXVlcnkiLCJTZXNzaW9uIiwiZXF1YWxUbyIsImZpbmQiLCJ1c2VNYXN0ZXJLZXkiLCJtYXAiLCJvYmoiLCJ0b0pTT04iLCJsZW5ndGgiLCJFcnJvciIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsIm5vdyIsIkRhdGUiLCJleHBpcmVzQXQiLCJpc28iLCJwYXNzd29yZCIsInB1dCIsInVzZXJPYmplY3QiLCJnZXRBdXRoRm9yTGVnYWN5U2Vzc2lvblRva2VuIiwidGhlbiIsInJlc3BvbnNlIiwiY2xhc3NOYW1lIiwiZ2V0VXNlclJvbGVzIiwiX2xvYWRSb2xlcyIsImdldFJvbGVzRm9yVXNlciIsInJlc3RXaGVyZSIsInVzZXJzIiwiX190eXBlIiwib2JqZWN0SWQiLCJpZCIsImVhY2giLCJyZXN1bHQiLCJwdXNoIiwiUm9sZSIsImNhY2hlZFJvbGVzIiwicm9sZSIsImNhY2hlUm9sZXMiLCJyb2xlc01hcCIsInJlZHVjZSIsIm0iLCJyIiwibmFtZXMiLCJuYW1lIiwiaWRzIiwicm9sZU5hbWVzIiwiX2dldEFsbFJvbGVzTmFtZXNGb3JSb2xlSWRzIiwiQXJyYXkiLCJnZXRSb2xlc0J5SWRzIiwiaW5zIiwiY29udGFpbmVkSW4iLCJyb2xlcyIsIiRpbiIsInJvbGVJRHMiLCJxdWVyaWVkUm9sZXMiLCJmaWx0ZXIiLCJyb2xlSUQiLCJ3YXNRdWVyaWVkIiwiU2V0IiwicmVzdWx0TWFwIiwibWVtbyIsImNvbmNhdCIsImNyZWF0ZVNlc3Npb24iLCJ1c2VySWQiLCJjcmVhdGVkV2l0aCIsImFkZGl0aW9uYWxTZXNzaW9uRGF0YSIsInRva2VuIiwibmV3VG9rZW4iLCJnZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQiLCJzZXNzaW9uRGF0YSIsInJlc3RyaWN0ZWQiLCJfZW5jb2RlIiwiYXNzaWduIiwiUmVzdFdyaXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7QUFBQSxNQUFNQSxXQUFXLEdBQUdDLE9BQU8sQ0FBQyxlQUFELENBQTNCOztBQUNBLE1BQU1DLFNBQVMsR0FBR0QsT0FBTyxDQUFDLGFBQUQsQ0FBekI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRixPQUFPLENBQUMsWUFBRCxDQUFyQixDLENBRUE7QUFDQTtBQUNBOzs7QUFDQSxTQUFTRyxJQUFULENBQWM7QUFDWkMsRUFBQUEsTUFEWTtBQUVaQyxFQUFBQSxlQUFlLEdBQUdDLFNBRk47QUFHWkMsRUFBQUEsUUFBUSxHQUFHLEtBSEM7QUFJWkMsRUFBQUEsVUFBVSxHQUFHLEtBSkQ7QUFLWkMsRUFBQUEsSUFMWTtBQU1aQyxFQUFBQTtBQU5ZLENBQWQsRUFPRztBQUNELE9BQUtOLE1BQUwsR0FBY0EsTUFBZDtBQUNBLE9BQUtDLGVBQUwsR0FBdUJBLGVBQWUsSUFBS0QsTUFBTSxJQUFJQSxNQUFNLENBQUNDLGVBQTVEO0FBQ0EsT0FBS0ssY0FBTCxHQUFzQkEsY0FBdEI7QUFDQSxPQUFLSCxRQUFMLEdBQWdCQSxRQUFoQjtBQUNBLE9BQUtFLElBQUwsR0FBWUEsSUFBWjtBQUNBLE9BQUtELFVBQUwsR0FBa0JB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LGNBQUosRUFBb0I7QUFDbEI0RixJQUFBQSxXQUFXLENBQUM1RixjQUFaLEdBQTZCQSxjQUE3QjtBQUNEOztBQUVEYyxFQUFBQSxNQUFNLENBQUNpRixNQUFQLENBQWNILFdBQWQsRUFBMkJKLHFCQUEzQixFQW5CQSxDQW9CQTs7QUFDQSxRQUFNUSxTQUFTLEdBQUcxRyxPQUFPLENBQUMsYUFBRCxDQUF6Qjs7QUFFQSxTQUFPO0FBQ0xzRyxJQUFBQSxXQURLO0FBRUxQLElBQUFBLGFBQWEsRUFBRSxNQUNiLElBQUlXLFNBQUosQ0FBY3RHLE1BQWQsRUFBc0JZLE1BQU0sQ0FBQ1osTUFBRCxDQUE1QixFQUFzQyxVQUF0QyxFQUFrRCxJQUFsRCxFQUF3RGtHLFdBQXhELEVBQXFFckUsT0FBckU7QUFIRyxHQUFQO0FBS0QsQ0EvQkQ7O0FBaUNBMEUsTUFBTSxDQUFDQyxPQUFQLEdBQWlCO0FBQ2Z6RyxFQUFBQSxJQURlO0FBRWZhLEVBQUFBLE1BRmU7QUFHZkUsRUFBQUEsTUFIZTtBQUlmRCxFQUFBQSxRQUplO0FBS2ZFLEVBQUFBLHNCQUxlO0FBTWZpQyxFQUFBQSw0QkFOZTtBQU9mMkMsRUFBQUE7QUFQZSxDQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IGNyeXB0b1V0aWxzID0gcmVxdWlyZSgnLi9jcnlwdG9VdGlscycpO1xuY29uc3QgUmVzdFF1ZXJ5ID0gcmVxdWlyZSgnLi9SZXN0UXVlcnknKTtcbmNvbnN0IFBhcnNlID0gcmVxdWlyZSgncGFyc2Uvbm9kZScpO1xuXG4vLyBBbiBBdXRoIG9iamVjdCB0ZWxscyB5b3Ugd2hvIGlzIHJlcXVlc3Rpbmcgc29tZXRoaW5nIGFuZCB3aGV0aGVyXG4vLyB0aGUgbWFzdGVyIGtleSB3YXMgdXNlZC5cbi8vIHVzZXJPYmplY3QgaXMgYSBQYXJzZS5Vc2VyIGFuZCBjYW4gYmUgbnVsbCBpZiB0aGVyZSdzIG5vIHVzZXIuXG5mdW5jdGlvbiBBdXRoKHtcbiAgY29uZmlnLFxuICBjYWNoZUNvbnRyb2xsZXIgPSB1bmRlZmluZWQsXG4gIGlzTWFzdGVyID0gZmFsc2UsXG4gIGlzUmVhZE9ubHkgPSBmYWxzZSxcbiAgdXNlcixcbiAgaW5zdGFsbGF0aW9uSWQsXG59KSB7XG4gIHRoaXMuY29uZmlnID0gY29uZmlnO1xuICB0aGlzLmNhY2hlQ29udHJvbGxlciA9IGNhY2hlQ29udHJvbGxlciB8fCAoY29uZmlnICYmIGNvbmZpZy5jYWNoZUNvbnRyb2xsZXIpO1xuICB0aGlzLmluc3RhbGxhdGlvbklkID0gaW5zdGFsbGF0aW9uSWQ7XG4gIHRoaXMuaXNNYXN0ZXIgPSBpc01hc3RlcjtcbiAgdGhpcy51c2VyID0gdXNlcjtcbiAgdGhpcy5pc1JlYWRPbmx5ID0gaXNSZWFkT25seTtcblxuICAvLyBBc3N1bWluZyBhIHVzZXJzIHJvbGVzIHdvbid0IGNoYW5nZSBkdXJpbmcgYSBzaW5nbGUgcmVxdWVzdCwgd2UnbGxcbiAgLy8gb25seSBsb2FkIHRoZW0gb25jZS5cbiAgdGhpcy51c2VyUm9sZXMgPSBbXTtcbiAgdGhpcy5mZXRjaGVkUm9sZXMgPSBmYWxzZTtcbiAgdGhpcy5yb2xlUHJvbWlzZSA9IG51bGw7XG59XG5cbi8vIFdoZXRoZXIgdGhpcyBhdXRoIGNvdWxkIHBvc3NpYmx5IG1vZGlmeSB0aGUgZ2l2ZW4gdXNlciBpZC5cbi8vIEl0IHN0aWxsIGNvdWxkIGJlIGZvcmJpZGRlbiB2aWEgQUNMcyBldmVuIGlmIHRoaXMgcmV0dXJucyB0cnVlLlxuQXV0aC5wcm90b3R5cGUuaXNVbmF1dGhlbnRpY2F0ZWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmICh0aGlzLnVzZXIpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59O1xuXG4vLyBBIGhlbHBlciB0byBnZXQgYSBtYXN0ZXItbGV2ZWwgQXV0aCBvYmplY3RcbmZ1bmN0aW9uIG1hc3Rlcihjb25maWcpIHtcbiAgcmV0dXJuIG5ldyBBdXRoKHsgY29uZmlnLCBpc01hc3RlcjogdHJ1ZSB9KTtcbn1cblxuLy8gQSBoZWxwZXIgdG8gZ2V0IGEgbWFzdGVyLWxldmVsIEF1dGggb2JqZWN0XG5mdW5jdGlvbiByZWFkT25seShjb25maWcpIHtcbiAgcmV0dXJuIG5ldyBBdXRoKHsgY29uZmlnLCBpc01hc3RlcjogdHJ1ZSwgaXNSZWFkT25seTogdHJ1ZSB9KTtcbn1cblxuLy8gQSBoZWxwZXIgdG8gZ2V0IGEgbm9ib2R5LWxldmVsIEF1dGggb2JqZWN0XG5mdW5jdGlvbiBub2JvZHkoY29uZmlnKSB7XG4gIHJldHVybiBuZXcgQXV0aCh7IGNvbmZpZywgaXNNYXN0ZXI6IGZhbHNlIH0pO1xufVxuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGFuIEF1dGggb2JqZWN0XG5jb25zdCBnZXRBdXRoRm9yU2Vzc2lvblRva2VuID0gYXN5bmMgZnVuY3Rpb24gKHtcbiAgY29uZmlnLFxuICBjYWNoZUNvbnRyb2xsZXIsXG4gIHNlc3Npb25Ub2tlbixcbiAgaW5zdGFsbGF0aW9uSWQsXG59KSB7XG4gIGNhY2hlQ29udHJvbGxlciA9IGNhY2hlQ29udHJvbGxlciB8fCAoY29uZmlnICYmIGNvbmZpZy5jYWNoZUNvbnRyb2xsZXIpO1xuICBpZiAoY2FjaGVDb250cm9sbGVyKSB7XG4gICAgY29uc3QgdXNlckpTT04gPSBhd2FpdCBjYWNoZUNvbnRyb2xsZXIudXNlci5nZXQoc2Vzc2lvblRva2VuKTtcbiAgICBpZiAodXNlckpTT04pIHtcbiAgICAgIGNvbnN0IGNhY2hlZFVzZXIgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04odXNlckpTT04pO1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShcbiAgICAgICAgbmV3IEF1dGgoe1xuICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICBjYWNoZUNvbnRyb2xsZXIsXG4gICAgICAgICAgaXNNYXN0ZXI6IGZhbHNlLFxuICAgICAgICAgIGluc3RhbGxhdGlvbklkLFxuICAgICAgICAgIHVzZXI6IGNhY2hlZFVzZXIsXG4gICAgICAgIH0pXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGxldCByZXN1bHRzO1xuICBpZiAoY29uZmlnKSB7XG4gICAgY29uc3QgcmVzdE9wdGlvbnMgPSB7XG4gICAgICBsaW1pdDogMSxcbiAgICAgIGluY2x1ZGU6ICd1c2VyJyxcbiAgICB9O1xuXG4gICAgY29uc3QgcXVlcnkgPSBuZXcgUmVzdFF1ZXJ5KGNvbmZpZywgbWFzdGVyKGNvbmZpZyksICdfU2Vzc2lvbicsIHsgc2Vzc2lvblRva2VuIH0sIHJlc3RPcHRpb25zKTtcbiAgICByZXN1bHRzID0gKGF3YWl0IHF1ZXJ5LmV4ZWN1dGUoKSkucmVzdWx0cztcbiAgfSBlbHNlIHtcbiAgICByZXN1bHRzID0gKFxuICAgICAgYXdhaXQgbmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlNlc3Npb24pXG4gICAgICAgIC5saW1pdCgxKVxuICAgICAgICAuaW5jbHVkZSgndXNlcicpXG4gICAgICAgIC5lcXVhbFRvKCdzZXNzaW9uVG9rZW4nLCBzZXNzaW9uVG9rZW4pXG4gICAgICAgIC5maW5kKHsgdXNlTWFzdGVyS2V5OiB0cnVlIH0pXG4gICAgKS5tYXAob2JqID0+IG9iai50b0pTT04oKSk7XG4gIH1cblxuICBpZiAocmVzdWx0cy5sZW5ndGggIT09IDEgfHwgIXJlc3VsdHNbMF1bJ3VzZXInXSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sICdJbnZhbGlkIHNlc3Npb24gdG9rZW4nKTtcbiAgfVxuICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpLFxuICAgIGV4cGlyZXNBdCA9IHJlc3VsdHNbMF0uZXhwaXJlc0F0ID8gbmV3IERhdGUocmVzdWx0c1swXS5leHBpcmVzQXQuaXNvKSA6IHVuZGVmaW5lZDtcbiAgaWYgKGV4cGlyZXNBdCA8IG5vdykge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sICdTZXNzaW9uIHRva2VuIGlzIGV4cGlyZWQuJyk7XG4gIH1cbiAgY29uc3Qgb2JqID0gcmVzdWx0c1swXVsndXNlciddO1xuICBkZWxldGUgb2JqLnBhc3N3b3JkO1xuICBvYmpbJ2NsYXNzTmFtZSddID0gJ19Vc2VyJztcbiAgb2JqWydzZXNzaW9uVG9rZW4nXSA9IHNlc3Npb25Ub2tlbjtcbiAgaWYgKGNhY2hlQ29udHJvbGxlcikge1xuICAgIGNhY2hlQ29udHJvbGxlci51c2VyLnB1dChzZXNzaW9uVG9rZW4sIG9iaik7XG4gIH1cbiAgY29uc3QgdXNlck9iamVjdCA9IFBhcnNlLk9iamVjdC5mcm9tSlNPTihvYmopO1xuICByZXR1cm4gbmV3IEF1dGgoe1xuICAgIGNvbmZpZyxcbiAgICBjYWNoZUNvbnRyb2xsZXIsXG4gICAgaXNNYXN0ZXI6IGZhbHNlLFxuICAgIGluc3RhbGxhdGlvbklkLFxuICAgIHVzZXI6IHVzZXJPYmplY3QsXG4gIH0pO1xufTtcblxudmFyIGdldEF1dGhGb3JMZWdhY3lTZXNzaW9uVG9rZW4gPSBmdW5jdGlvbiAoeyBjb25maWcsIHNlc3Npb25Ub2tlbiwgaW5zdGFsbGF0aW9uSWQgfSkge1xuICB2YXIgcmVzdE9wdGlvbnMgPSB7XG4gICAgbGltaXQ6IDEsXG4gIH07XG4gIHZhciBxdWVyeSA9IG5ldyBSZXN0UXVlcnkoY29uZmlnLCBtYXN0ZXIoY29uZmlnKSwgJ19Vc2VyJywgeyBzZXNzaW9uVG9rZW4gfSwgcmVzdE9wdGlvbnMpO1xuICByZXR1cm4gcXVlcnkuZXhlY3V0ZSgpLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgIHZhciByZXN1bHRzID0gcmVzcG9uc2UucmVzdWx0cztcbiAgICBpZiAocmVzdWx0cy5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4sICdpbnZhbGlkIGxlZ2FjeSBzZXNzaW9uIHRva2VuJyk7XG4gICAgfVxuICAgIGNvbnN0IG9iaiA9IHJlc3VsdHNbMF07XG4gICAgb2JqLmNsYXNzTmFtZSA9ICdfVXNlcic7XG4gICAgY29uc3QgdXNlck9iamVjdCA9IFBhcnNlLk9iamVjdC5mcm9tSlNPTihvYmopO1xuICAgIHJldHVybiBuZXcgQXV0aCh7XG4gICAgICBjb25maWcsXG4gICAgICBpc01hc3RlcjogZmFsc2UsXG4gICAgICBpbnN0YWxsYXRpb25JZCxcbiAgICAgIHVzZXI6IHVzZXJPYmplY3QsXG4gICAgfSk7XG4gIH0pO1xufTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhbiBhcnJheSBvZiByb2xlIG5hbWVzXG5BdXRoLnByb3RvdHlwZS5nZXRVc2VyUm9sZXMgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmlzTWFzdGVyIHx8ICF0aGlzLnVzZXIpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgfVxuICBpZiAodGhpcy5mZXRjaGVkUm9sZXMpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRoaXMudXNlclJvbGVzKTtcbiAgfVxuICBpZiAodGhpcy5yb2xlUHJvbWlzZSkge1xuICAgIHJldHVybiB0aGlzLnJvbGVQcm9taXNlO1xuICB9XG4gIHRoaXMucm9sZVByb21pc2UgPSB0aGlzLl9sb2FkUm9sZXMoKTtcbiAgcmV0dXJuIHRoaXMucm9sZVByb21pc2U7XG59O1xuXG5BdXRoLnByb3RvdHlwZS5nZXRSb2xlc0ZvclVzZXIgPSBhc3luYyBmdW5jdGlvbiAoKSB7XG4gIC8vU3RhY2sgYWxsIFBhcnNlLlJvbGVcbiAgY29uc3QgcmVzdWx0cyA9IFtdO1xuICBpZiAodGhpcy5jb25maWcpIHtcbiAgICBjb25zdCByZXN0V2hlcmUgPSB7XG4gICAgICB1c2Vyczoge1xuICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgY2xhc3NOYW1lOiAnX1VzZXInLFxuICAgICAgICBvYmplY3RJZDogdGhpcy51c2VyLmlkLFxuICAgICAgfSxcbiAgICB9O1xuICAgIGF3YWl0IG5ldyBSZXN0UXVlcnkodGhpcy5jb25maWcsIG1hc3Rlcih0aGlzLmNvbmZpZyksICdfUm9sZScsIHJlc3RXaGVyZSwge30pLmVhY2gocmVzdWx0ID0+XG4gICAgICByZXN1bHRzLnB1c2gocmVzdWx0KVxuICAgICk7XG4gIH0gZWxzZSB7XG4gICAgYXdhaXQgbmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlJvbGUpXG4gICAgICAuZXF1YWxUbygndXNlcnMnLCB0aGlzLnVzZXIpXG4gICAgICAuZWFjaChyZXN1bHQgPT4gcmVzdWx0cy5wdXNoKHJlc3VsdC50b0pTT04oKSksIHsgdXNlTWFzdGVyS2V5OiB0cnVlIH0pO1xuICB9XG4gIHJldHVybiByZXN1bHRzO1xufTtcblxuLy8gSXRlcmF0ZXMgdGhyb3VnaCB0aGUgcm9sZSB0cmVlIGFuZCBjb21waWxlcyBhIHVzZXIncyByb2xlc1xuQXV0aC5wcm90b3R5cGUuX2xvYWRSb2xlcyA9IGFzeW5jIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY2FjaGVDb250cm9sbGVyKSB7XG4gICAgY29uc3QgY2FjaGVkUm9sZXMgPSBhd2FpdCB0aGlzLmNhY2hlQ29udHJvbGxlci5yb2xlLmdldCh0aGlzLnVzZXIuaWQpO1xuICAgIGlmIChjYWNoZWRSb2xlcyAhPSBudWxsKSB7XG4gICAgICB0aGlzLmZldGNoZWRSb2xlcyA9IHRydWU7XG4gICAgICB0aGlzLnVzZXJSb2xlcyA9IGNhY2hlZFJvbGVzO1xuICAgICAgcmV0dXJuIGNhY2hlZFJvbGVzO1xuICAgIH1cbiAgfVxuXG4gIC8vIEZpcnN0IGdldCB0aGUgcm9sZSBpZHMgdGhpcyB1c2VyIGlzIGRpcmVjdGx5IGEgbWVtYmVyIG9mXG4gIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCB0aGlzLmdldFJvbGVzRm9yVXNlcigpO1xuICBpZiAoIXJlc3VsdHMubGVuZ3RoKSB7XG4gICAgdGhpcy51c2VyUm9sZXMgPSBbXTtcbiAgICB0aGlzLmZldGNoZWRSb2xlcyA9IHRydWU7XG4gICAgdGhpcy5yb2xlUHJvbWlzZSA9IG51bGw7XG5cbiAgICB0aGlzLmNhY2hlUm9sZXMoKTtcbiAgICByZXR1cm4gdGhpcy51c2VyUm9sZXM7XG4gIH1cblxuICBjb25zdCByb2xlc01hcCA9IHJlc3VsdHMucmVkdWNlKFxuICAgIChtLCByKSA9PiB7XG4gICAgICBtLm5hbWVzLnB1c2goci5uYW1lKTtcbiAgICAgIG0uaWRzLnB1c2goci5vYmplY3RJZCk7XG4gICAgICByZXR1cm4gbTtcbiAgICB9LFxuICAgIHsgaWRzOiBbXSwgbmFtZXM6IFtdIH1cbiAgKTtcblxuICAvLyBydW4gdGhlIHJlY3Vyc2l2ZSBmaW5kaW5nXG4gIGNvbnN0IHJvbGVOYW1lcyA9IGF3YWl0IHRoaXMuX2dldEFsbFJvbGVzTmFtZXNGb3JSb2xlSWRzKHJvbGVzTWFwLmlkcywgcm9sZXNNYXAubmFtZXMpO1xuICB0aGlzLnVzZXJSb2xlcyA9IHJvbGVOYW1lcy5tYXAociA9PiB7XG4gICAgcmV0dXJuICdyb2xlOicgKyByO1xuICB9KTtcbiAgdGhpcy5mZXRjaGVkUm9sZXMgPSB0cnVlO1xuICB0aGlzLnJvbGVQcm9taXNlID0gbnVsbDtcbiAgdGhpcy5jYWNoZVJvbGVzKCk7XG4gIHJldHVybiB0aGlzLnVzZXJSb2xlcztcbn07XG5cbkF1dGgucHJvdG90eXBlLmNhY2hlUm9sZXMgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5jYWNoZUNvbnRyb2xsZXIpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgdGhpcy5jYWNoZUNvbnRyb2xsZXIucm9sZS5wdXQodGhpcy51c2VyLmlkLCBBcnJheSguLi50aGlzLnVzZXJSb2xlcykpO1xuICByZXR1cm4gdHJ1ZTtcbn07XG5cbkF1dGgucHJvdG90eXBlLmdldFJvbGVzQnlJZHMgPSBhc3luYyBmdW5jdGlvbiAoaW5zKSB7XG4gIGNvbnN0IHJlc3VsdHMgPSBbXTtcbiAgLy8gQnVpbGQgYW4gT1IgcXVlcnkgYWNyb3NzIGFsbCBwYXJlbnRSb2xlc1xuICBpZiAoIXRoaXMuY29uZmlnKSB7XG4gICAgYXdhaXQgbmV3IFBhcnNlLlF1ZXJ5KFBhcnNlLlJvbGUpXG4gICAgICAuY29udGFpbmVkSW4oXG4gICAgICAgICdyb2xlcycsXG4gICAgICAgIGlucy5tYXAoaWQgPT4ge1xuICAgICAgICAgIGNvbnN0IHJvbGUgPSBuZXcgUGFyc2UuT2JqZWN0KFBhcnNlLlJvbGUpO1xuICAgICAgICAgIHJvbGUuaWQgPSBpZDtcbiAgICAgICAgICByZXR1cm4gcm9sZTtcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICAgIC5lYWNoKHJlc3VsdCA9PiByZXN1bHRzLnB1c2gocmVzdWx0LnRvSlNPTigpKSwgeyB1c2VNYXN0ZXJLZXk6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgcm9sZXMgPSBpbnMubWFwKGlkID0+IHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICBjbGFzc05hbWU6ICdfUm9sZScsXG4gICAgICAgIG9iamVjdElkOiBpZCxcbiAgICAgIH07XG4gICAgfSk7XG4gICAgY29uc3QgcmVzdFdoZXJlID0geyByb2xlczogeyAkaW46IHJvbGVzIH0gfTtcbiAgICBhd2FpdCBuZXcgUmVzdFF1ZXJ5KHRoaXMuY29uZmlnLCBtYXN0ZXIodGhpcy5jb25maWcpLCAnX1JvbGUnLCByZXN0V2hlcmUsIHt9KS5lYWNoKHJlc3VsdCA9PlxuICAgICAgcmVzdWx0cy5wdXNoKHJlc3VsdClcbiAgICApO1xuICB9XG4gIHJldHVybiByZXN1bHRzO1xufTtcblxuLy8gR2l2ZW4gYSBsaXN0IG9mIHJvbGVJZHMsIGZpbmQgYWxsIHRoZSBwYXJlbnQgcm9sZXMsIHJldHVybnMgYSBwcm9taXNlIHdpdGggYWxsIG5hbWVzXG5BdXRoLnByb3RvdHlwZS5fZ2V0QWxsUm9sZXNOYW1lc0ZvclJvbGVJZHMgPSBmdW5jdGlvbiAocm9sZUlEcywgbmFtZXMgPSBbXSwgcXVlcmllZFJvbGVzID0ge30pIHtcbiAgY29uc3QgaW5zID0gcm9sZUlEcy5maWx0ZXIocm9sZUlEID0+IHtcbiAgICBjb25zdCB3YXNRdWVyaWVkID0gcXVlcmllZFJvbGVzW3JvbGVJRF0gIT09IHRydWU7XG4gICAgcXVlcmllZFJvbGVzW3JvbGVJRF0gPSB0cnVlO1xuICAgIHJldHVybiB3YXNRdWVyaWVkO1xuICB9KTtcblxuICAvLyBhbGwgcm9sZXMgYXJlIGFjY291bnRlZCBmb3IsIHJldHVybiB0aGUgbmFtZXNcbiAgaWYgKGlucy5sZW5ndGggPT0gMCkge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoWy4uLm5ldyBTZXQobmFtZXMpXSk7XG4gIH1cblxuICByZXR1cm4gdGhpcy5nZXRSb2xlc0J5SWRzKGlucylcbiAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgIC8vIE5vdGhpbmcgZm91bmRcbiAgICAgIGlmICghcmVzdWx0cy5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShuYW1lcyk7XG4gICAgICB9XG4gICAgICAvLyBNYXAgdGhlIHJlc3VsdHMgd2l0aCBhbGwgSWRzIGFuZCBuYW1lc1xuICAgICAgY29uc3QgcmVzdWx0TWFwID0gcmVzdWx0cy5yZWR1Y2UoXG4gICAgICAgIChtZW1vLCByb2xlKSA9PiB7XG4gICAgICAgICAgbWVtby5uYW1lcy5wdXNoKHJvbGUubmFtZSk7XG4gICAgICAgICAgbWVtby5pZHMucHVzaChyb2xlLm9iamVjdElkKTtcbiAgICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgICAgfSxcbiAgICAgICAgeyBpZHM6IFtdLCBuYW1lczogW10gfVxuICAgICAgKTtcbiAgICAgIC8vIHN0b3JlIHRoZSBuZXcgZm91bmQgbmFtZXNcbiAgICAgIG5hbWVzID0gbmFtZXMuY29uY2F0KHJlc3VsdE1hcC5uYW1lcyk7XG4gICAgICAvLyBmaW5kIHRoZSBuZXh0IG9uZXMsIGNpcmN1bGFyIHJvbGVzIHdpbGwgYmUgY3V0XG4gICAgICByZXR1cm4gdGhpcy5fZ2V0QWxsUm9sZXNOYW1lc0ZvclJvbGVJZHMocmVzdWx0TWFwLmlkcywgbmFtZXMsIHF1ZXJpZWRSb2xlcyk7XG4gICAgfSlcbiAgICAudGhlbihuYW1lcyA9PiB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFsuLi5uZXcgU2V0KG5hbWVzKV0pO1xuICAgIH0pO1xufTtcblxuY29uc3QgY3JlYXRlU2Vzc2lvbiA9IGZ1bmN0aW9uIChcbiAgY29uZmlnLFxuICB7IHVzZXJJZCwgY3JlYXRlZFdpdGgsIGluc3RhbGxhdGlvbklkLCBhZGRpdGlvbmFsU2Vzc2lvbkRhdGEgfVxuKSB7XG4gIGNvbnN0IHRva2VuID0gJ3I6JyArIGNyeXB0b1V0aWxzLm5ld1Rva2VuKCk7XG4gIGNvbnN0IGV4cGlyZXNBdCA9IGNvbmZpZy5nZW5lcmF0ZVNlc3Npb25FeHBpcmVzQXQoKTtcbiAgY29uc3Qgc2Vzc2lvbkRhdGEgPSB7XG4gICAgc2Vzc2lvblRva2VuOiB0b2tlbixcbiAgICB1c2VyOiB7XG4gICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgIG9iamVjdElkOiB1c2VySWQsXG4gICAgfSxcbiAgICBjcmVhdGVkV2l0aCxcbiAgICByZXN0cmljdGVkOiBmYWxzZSxcbiAgICBleHBpcmVzQXQ6IFBhcnNlLl9lbmNvZGUoZXhwaXJlc0F0KSxcbiAgfTtcblxuICBpZiAoaW5zdGFsbGF0aW9uSWQpIHtcbiAgICBzZXNzaW9uRGF0YS5pbnN0YWxsYXRpb25JZCA9IGluc3RhbGxhdGlvbklkO1xuICB9XG5cbiAgT2JqZWN0LmFzc2lnbihzZXNzaW9uRGF0YSwgYWRkaXRpb25hbFNlc3Npb25EYXRhKTtcbiAgLy8gV2UgbmVlZCB0byBpbXBvcnQgUmVzdFdyaXRlIGF0IHRoaXMgcG9pbnQgZm9yIHRoZSBjeWNsaWMgZGVwZW5kZW5jeSBpdCBoYXMgdG8gaXRcbiAgY29uc3QgUmVzdFdyaXRlID0gcmVxdWlyZSgnLi9SZXN0V3JpdGUnKTtcblxuICByZXR1cm4ge1xuICAgIHNlc3Npb25EYXRhLFxuICAgIGNyZWF0ZVNlc3Npb246ICgpID0+XG4gICAgICBuZXcgUmVzdFdyaXRlKGNvbmZpZywgbWFzdGVyKGNvbmZpZyksICdfU2Vzc2lvbicsIG51bGwsIHNlc3Npb25EYXRhKS5leGVjdXRlKCksXG4gIH07XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgQXV0aCxcbiAgbWFzdGVyLFxuICBub2JvZHksXG4gIHJlYWRPbmx5LFxuICBnZXRBdXRoRm9yU2Vzc2lvblRva2VuLFxuICBnZXRBdXRoRm9yTGVnYWN5U2Vzc2lvblRva2VuLFxuICBjcmVhdGVTZXNzaW9uLFxufTtcbiJdfQ==