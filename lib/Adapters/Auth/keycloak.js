"use strict";

/*
  # Parse Server Keycloak Authentication

  ## Keycloak `authData`

  ```
    {
      "keycloak": {
        "access_token": "access token you got from keycloak JS client authentication",
        "id": "the id retrieved from client authentication in Keycloak",
        "roles": ["the roles retrieved from client authentication in Keycloak"],
        "groups": ["the groups retrieved from client authentication in Keycloak"]
      }
    }
  ```

  The authentication module will test if the authData is the same as the
  userinfo oauth call, comparing the attributes

  Copy the JSON config file generated on Keycloak (https://www.keycloak.org/docs/latest/securing_apps/index.html#_javascript_adapter)
  and paste it inside of a folder (Ex.: `auth/keycloak.json`) in your server.

  The options passed to Parse server:

  ```
    {
      auth: {
        keycloak: {
          config: require(`./auth/keycloak.json`)
        }
      }
    }
  ```
*/
const {
  Parse
} = require('parse/node');

const httpsRequest = require('./httpsRequest');

const arraysEqual = (_arr1, _arr2) => {
  if (!Array.isArray(_arr1) || !Array.isArray(_arr2) || _arr1.length !== _arr2.length) return false;

  var arr1 = _arr1.concat().sort();

  var arr2 = _arr2.concat().sort();

  for (var i = 0; i < arr1.length; i++) {
    if (arr1[i] !== arr2[i]) return false;
  }

  return true;
};

const handleAuth = async ({
  access_token,
  id,
  roles,
  groups
} = {}, {
  config
} = {}) => {
  if (!(access_token && id)) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Missing access token and/or User id');
  }

  if (!config || !(config['auth-server-url'] && config['realm'])) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Missing keycloak configuration');
  }

  try {
    const response = await httpsRequest.get({
      host: config['auth-server-url'],
      path: `/realms/${config['realm']}/protocol/openid-connect/userinfo`,
      headers: {
        Authorization: 'Bearer ' + access_token
      }
    });

    if (response && response.data && response.data.sub == id && arraysEqual(response.data.roles, roles) && arraysEqual(response.data.groups, groups)) {
      return;
    }

    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Invalid authentication');
  } catch (e) {
    if (e instanceof Parse.Error) {
      throw e;
    }

    const error = JSON.parse(e.text);

    if (error.error_description) {
      throw new Parse.Error(Parse.Error.HOSTING_ERROR, error.error_description);
    } else {
      throw new Parse.Error(Parse.Error.HOSTING_ERROR, 'Could not connect to the authentication server');
    }
  }
};
/*
  @param {Object} authData: the client provided authData
  @param {string} authData.access_token: the access_token retrieved from client authentication in Keycloak
  @param {string} authData.id: the id retrieved from client authentication in Keycloak
  @param {Array}  authData.roles: the roles retrieved from client authentication in Keycloak
  @param {Array}  authData.groups: the groups retrieved from client authentication in Keycloak
  @param {Object} options: additional options
  @param {Object} options.config: the config object passed during Parse Server instantiation
*/


function validateAuthData(authData, options = {}) {
  return handleAuth(authData, options);
} // Returns a promise that fulfills if this app id is valid.


function validateAppId() {
  return Promise.resolve();
}

module.exports = {
  validateAppId,
  validateAuthData
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9BdXRoL2tleWNsb2FrLmpzIl0sIm5hbWVzIjpbIlBhcnNlIiwicmVxdWlyZSIsImh0dHBzUmVxdWVzdCIsImFycmF5c0VxdWFsIiwiX2FycjEiLCJfYXJyMiIsIkFycmF5IiwiaXNBcnJheSIsImxlbmd0aCIsImFycjEiLCJjb25jYXQiLCJzb3J0IiwiYXJyMiIsImkiLCJoYW5kbGVBdXRoIiwiYWNjZXNzX3Rva2VuIiwiaWQiLCJyb2xlcyIsImdyb3VwcyIsImNvbmZpZyIsIkVycm9yIiwiT0JKRUNUX05PVF9GT1VORCIsInJlc3BvbnNlIiwiZ2V0IiwiaG9zdCIsInBhdGgiLCJoZWFkZXJzIiwiQXV0aG9yaXphdGlvbiIsImRhdGEiLCJzdWIiLCJlIiwiZXJyb3IiLCJKU09OIiwicGFyc2UiLCJ0ZXh0IiwiZXJyb3JfZGVzY3JpcHRpb24iLCJIT1NUSU5HX0VSUk9SIiwidmFsaWRhdGVBdXRoRGF0YSIsImF1dGhEYXRhIiwib3B0aW9ucyIsInZhbGlkYXRlQXBwSWQiLCJQcm9taXNlIiwicmVzb2x2ZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFtQ0EsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVlDLE9BQU8sQ0FBQyxZQUFELENBQXpCOztBQUNBLE1BQU1DLFlBQVksR0FBR0QsT0FBTyxDQUFDLGdCQUFELENBQTVCOztBQUVBLE1BQU1FLFdBQVcsR0FBRyxDQUFDQyxLQUFELEVBQVFDLEtBQVIsS0FBa0I7QUFDcEMsTUFBSSxDQUFDQyxLQUFLLENBQUNDLE9BQU4sQ0FBY0gsS0FBZCxDQUFELElBQXlCLENBQUNFLEtBQUssQ0FBQ0MsT0FBTixDQUFjRixLQUFkLENBQTFCLElBQWtERCxLQUFLLENBQUNJLE1BQU4sS0FBaUJILEtBQUssQ0FBQ0csTUFBN0UsRUFBcUYsT0FBTyxLQUFQOztBQUVyRixNQUFJQyxJQUFJLEdB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MUIsRUFBb0NDLE9BQU8sR0FBRyxFQUE5QyxFQUFrRDtBQUNoRCxTQUFPekIsVUFBVSxDQUFDd0IsUUFBRCxFQUFXQyxPQUFYLENBQWpCO0FBQ0QsQyxDQUVEOzs7QUFDQSxTQUFTQyxhQUFULEdBQXlCO0FBQ3ZCLFNBQU9DLE9BQU8sQ0FBQ0MsT0FBUixFQUFQO0FBQ0Q7O0FBRURDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjtBQUNmSixFQUFBQSxhQURlO0FBRWZILEVBQUFBO0FBRmUsQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvKlxuICAjIFBhcnNlIFNlcnZlciBLZXljbG9hayBBdXRoZW50aWNhdGlvblxuXG4gICMjIEtleWNsb2FrIGBhdXRoRGF0YWBcblxuICBgYGBcbiAgICB7XG4gICAgICBcImtleWNsb2FrXCI6IHtcbiAgICAgICAgXCJhY2Nlc3NfdG9rZW5cIjogXCJhY2Nlc3MgdG9rZW4geW91IGdvdCBmcm9tIGtleWNsb2FrIEpTIGNsaWVudCBhdXRoZW50aWNhdGlvblwiLFxuICAgICAgICBcImlkXCI6IFwidGhlIGlkIHJldHJpZXZlZCBmcm9tIGNsaWVudCBhdXRoZW50aWNhdGlvbiBpbiBLZXljbG9ha1wiLFxuICAgICAgICBcInJvbGVzXCI6IFtcInRoZSByb2xlcyByZXRyaWV2ZWQgZnJvbSBjbGllbnQgYXV0aGVudGljYXRpb24gaW4gS2V5Y2xvYWtcIl0sXG4gICAgICAgIFwiZ3JvdXBzXCI6IFtcInRoZSBncm91cHMgcmV0cmlldmVkIGZyb20gY2xpZW50IGF1dGhlbnRpY2F0aW9uIGluIEtleWNsb2FrXCJdXG4gICAgICB9XG4gICAgfVxuICBgYGBcblxuICBUaGUgYXV0aGVudGljYXRpb24gbW9kdWxlIHdpbGwgdGVzdCBpZiB0aGUgYXV0aERhdGEgaXMgdGhlIHNhbWUgYXMgdGhlXG4gIHVzZXJpbmZvIG9hdXRoIGNhbGwsIGNvbXBhcmluZyB0aGUgYXR0cmlidXRlc1xuXG4gIENvcHkgdGhlIEpTT04gY29uZmlnIGZpbGUgZ2VuZXJhdGVkIG9uIEtleWNsb2FrIChodHRwczovL3d3dy5rZXljbG9hay5vcmcvZG9jcy9sYXRlc3Qvc2VjdXJpbmdfYXBwcy9pbmRleC5odG1sI19qYXZhc2NyaXB0X2FkYXB0ZXIpXG4gIGFuZCBwYXN0ZSBpdCBpbnNpZGUgb2YgYSBmb2xkZXIgKEV4LjogYGF1dGgva2V5Y2xvYWsuanNvbmApIGluIHlvdXIgc2VydmVyLlxuXG4gIFRoZSBvcHRpb25zIHBhc3NlZCB0byBQYXJzZSBzZXJ2ZXI6XG5cbiAgYGBgXG4gICAge1xuICAgICAgYXV0aDoge1xuICAgICAgICBrZXljbG9hazoge1xuICAgICAgICAgIGNvbmZpZzogcmVxdWlyZShgLi9hdXRoL2tleWNsb2FrLmpzb25gKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICBgYGBcbiovXG5cbmNvbnN0IHsgUGFyc2UgfSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKTtcbmNvbnN0IGh0dHBzUmVxdWVzdCA9IHJlcXVpcmUoJy4vaHR0cHNSZXF1ZXN0Jyk7XG5cbmNvbnN0IGFycmF5c0VxdWFsID0gKF9hcnIxLCBfYXJyMikgPT4ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoX2FycjEpIHx8ICFBcnJheS5pc0FycmF5KF9hcnIyKSB8fCBfYXJyMS5sZW5ndGggIT09IF9hcnIyLmxlbmd0aCkgcmV0dXJuIGZhbHNlO1xuXG4gIHZhciBhcnIxID0gX2FycjEuY29uY2F0KCkuc29ydCgpO1xuICB2YXIgYXJyMiA9IF9hcnIyLmNvbmNhdCgpLnNvcnQoKTtcblxuICBmb3IgKHZhciBpID0gMDsgaSA8IGFycjEubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoYXJyMVtpXSAhPT0gYXJyMltpXSkgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59O1xuXG5jb25zdCBoYW5kbGVBdXRoID0gYXN5bmMgKHsgYWNjZXNzX3Rva2VuLCBpZCwgcm9sZXMsIGdyb3VwcyB9ID0ge30sIHsgY29uZmlnIH0gPSB7fSkgPT4ge1xuICBpZiAoIShhY2Nlc3NfdG9rZW4gJiYgaWQpKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdNaXNzaW5nIGFjY2VzcyB0b2tlbiBhbmQvb3IgVXNlciBpZCcpO1xuICB9XG4gIGlmICghY29uZmlnIHx8ICEoY29uZmlnWydhdXRoLXNlcnZlci11cmwnXSAmJiBjb25maWdbJ3JlYWxtJ10pKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdNaXNzaW5nIGtleWNsb2FrIGNvbmZpZ3VyYXRpb24nKTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgaHR0cHNSZXF1ZXN0LmdldCh7XG4gICAgICBob3N0OiBjb25maWdbJ2F1dGgtc2VydmVyLXVybCddLFxuICAgICAgcGF0aDogYC9yZWFsbXMvJHtjb25maWdbJ3JlYWxtJ119L3Byb3RvY29sL29wZW5pZC1jb25uZWN0L3VzZXJpbmZvYCxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgQXV0aG9yaXphdGlvbjogJ0JlYXJlciAnICsgYWNjZXNzX3Rva2VuLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBpZiAoXG4gICAgICByZXNwb25zZSAmJlxuICAgICAgcmVzcG9uc2UuZGF0YSAmJlxuICAgICAgcmVzcG9uc2UuZGF0YS5zdWIgPT0gaWQgJiZcbiAgICAgIGFycmF5c0VxdWFsKHJlc3BvbnNlLmRhdGEucm9sZXMsIHJvbGVzKSAmJlxuICAgICAgYXJyYXlzRXF1YWwocmVzcG9uc2UuZGF0YS5ncm91cHMsIGdyb3VwcylcbiAgICApIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdJbnZhbGlkIGF1dGhlbnRpY2F0aW9uJyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgICBjb25zdCBlcnJvciA9IEpTT04ucGFyc2UoZS50ZXh0KTtcbiAgICBpZiAoZXJyb3IuZXJyb3JfZGVzY3JpcHRpb24pIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5IT1NUSU5HX0VSUk9SLCBlcnJvci5lcnJvcl9kZXNjcmlwdGlvbik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuSE9TVElOR19FUlJPUixcbiAgICAgICAgJ0NvdWxkIG5vdCBjb25uZWN0IHRvIHRoZSBhdXRoZW50aWNhdGlvbiBzZXJ2ZXInXG4gICAgICApO1xuICAgIH1cbiAgfVxufTtcblxuLypcbiAgQHBhcmFtIHtPYmplY3R9IGF1dGhEYXRhOiB0aGUgY2xpZW50IHByb3ZpZGVkIGF1dGhEYXRhXG4gIEBwYXJhbSB7c3RyaW5nfSBhdXRoRGF0YS5hY2Nlc3NfdG9rZW46IHRoZSBhY2Nlc3NfdG9rZW4gcmV0cmlldmVkIGZyb20gY2xpZW50IGF1dGhlbnRpY2F0aW9uIGluIEtleWNsb2FrXG4gIEBwYXJhbSB7c3RyaW5nfSBhdXRoRGF0YS5pZDogdGhlIGlkIHJldHJpZXZlZCBmcm9tIGNsaWVudCBhdXRoZW50aWNhdGlvbiBpbiBLZXljbG9ha1xuICBAcGFyYW0ge0FycmF5fSAgYXV0aERhdGEucm9sZXM6IHRoZSByb2xlcyByZXRyaWV2ZWQgZnJvbSBjbGllbnQgYXV0aGVudGljYXRpb24gaW4gS2V5Y2xvYWtcbiAgQHBhcmFtIHtBcnJheX0gIGF1dGhEYXRhLmdyb3VwczogdGhlIGdyb3VwcyByZXRyaWV2ZWQgZnJvbSBjbGllbnQgYXV0aGVudGljYXRpb24gaW4gS2V5Y2xvYWtcbiAgQHBhcmFtIHtPYmplY3R9IG9wdGlvbnM6IGFkZGl0aW9uYWwgb3B0aW9uc1xuICBAcGFyYW0ge09iamVjdH0gb3B0aW9ucy5jb25maWc6IHRoZSBjb25maWcgb2JqZWN0IHBhc3NlZCBkdXJpbmcgUGFyc2UgU2VydmVyIGluc3RhbnRpYXRpb25cbiovXG5mdW5jdGlvbiB2YWxpZGF0ZUF1dGhEYXRhKGF1dGhEYXRhLCBvcHRpb25zID0ge30pIHtcbiAgcmV0dXJuIGhhbmRsZUF1dGgoYXV0aERhdGEsIG9wdGlvbnMpO1xufVxuXG4vLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IGZ1bGZpbGxzIGlmIHRoaXMgYXBwIGlkIGlzIHZhbGlkLlxuZnVuY3Rpb24gdmFsaWRhdGVBcHBJZCgpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgdmFsaWRhdGVBcHBJZCxcbiAgdmFsaWRhdGVBdXRoRGF0YSxcbn07XG4iXX0=