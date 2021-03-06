"use strict";

// Helper functions for accessing the twitter API.
var OAuth = require('./OAuth1Client');

var Parse = require('parse/node').Parse; // Returns a promise that fulfills iff this user id is valid.


function validateAuthData(authData, options) {
  if (!options) {
    throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Twitter auth configuration missing');
  }

  options = handleMultipleConfigurations(authData, options);
  var client = new OAuth(options);
  client.host = 'api.twitter.com';
  client.auth_token = authData.auth_token;
  client.auth_token_secret = authData.auth_token_secret;
  return client.get('/1.1/account/verify_credentials.json').then(data => {
    if (data && data.id_str == '' + authData.id) {
      return;
    }

    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Twitter auth is invalid for this user.');
  });
} // Returns a promise that fulfills iff this app id is valid.


function validateAppId() {
  return Promise.resolve();
}

function handleMultipleConfigurations(authData, options) {
  if (Array.isArray(options)) {
    const consumer_key = authData.consumer_key;

    if (!consumer_key) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Twitter auth is invalid for this user.');
    }

    options = options.filter(option => {
      return option.consumer_key == consumer_key;
    });

    if (options.length == 0) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Twitter auth is invalid for this user.');
    }

    options = options[0];
  }

  return options;
}

module.exports = {
  validateAppId,
  validateAuthData,
  handleMultipleConfigurations
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9BdXRoL3R3aXR0ZXIuanMiXSwibmFtZXMiOlsiT0F1dGgiLCJyZXF1aXJlIiwiUGFyc2UiLCJ2YWxpZGF0ZUF1dGhEYXRhIiwiYXV0aERhdGEiLCJvcHRpb25zIiwiRXJyb3IiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJoYW5kbGVNdWx0aXBsZUNvbmZpZ3VyYXRpb25zIiwiY2xpZW50IiwiaG9zdCIsImF1dGhfdG9rZW4iLCJhdXRoX3Rva2VuX3NlY3JldCIsImdldCIsInRoZW4iLCJkYXRhIiwiaWRfc3RyIiwiaWQiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwidmFsaWRhdGVBcHBJZCIsIlByb21pc2UiLCJyZXNvbHZlIiwiQXJyYXkiLCJpc0FycmF5IiwiY29uc3VtZXJfa2V5IiwiZmlsdGVyIiwib3B0aW9uIiwibGVuZ3RoIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7QUFBQTtBQUNBLElBQUlBLEtBQUssR0FBR0MsT0FBTyxDQUFDLGdCQUFELENBQW5COztBQUNBLElBQUlDLEtBQUssR0FBR0QsT0FBTyxDQUFDLFlBQUQsQ0FBUCxDQUFzQkMsS0FBbEMsQyxDQUVBOzs7QUFDQSxTQUFTQyxnQkFBVCxDQUEwQkMsUUFBMUIsRUFBb0NDLE9BQXBDLEVBQTZDO0FBQzNDLE1BQUksQ0FBQ0EsT0FBTCxFQUFjO0FBQ1osVUFBTSxJQUFJSCxLQUFLLENBQUNJLEtBQVYsQ0FBZ0JKLEtBQUssQ0FBQ0ksS0FBTixDQUFZQyxxQkFBNUIsRUFBbUQsb0NBQW5ELENBQU47QUFDRDs7QUFDREYsRUFBQUEsT0FBTyxHQUFHRyw0QkFBNEIsQ0FBQ0osUUFBRCxFQUFXQyxPQUFYLENBQXRDO0FBQ0EsTUFBSUksTUFBTSxHQUFHLElBQUlULEtBQUosQ0FBVUssT0FBVixDQUFiO0FBQ0FJLEVBQUFBLE1BQU0sQ0FBQ0MsSUFBUCxHQUFjLGlCQUFkO0FBQ0FELEVBQUFBLE1BQU0sQ0FBQ0UsVUFBUCxHQUFvQlAsUUFBUSxDQUFDTyxVQUE3QjtBQUNBRixFQUFBQSxNQUFNLENBQUNHLGlCQUFQLEdBQTJCUixRQUFRLENBQUNRLGlCQUFwQztBQUVBLFNBQU9ILE1BQU0sQ0FBQ0ksR0FBUCxDQUFXLHNDQUFYLEVBQW1EQyxJQUFuRCxDQUF3REMsSUFBSSxJQUFJO0FBQ3JFLFFBQUlBLElBQUksSUFBSUEsSUFBSSxDQUFDQyxNQUFMLElBQWUsS0FBS1osUUFBUSxDQUFDYSxFQUF6QyxFQUE2QztBQUMzQztBQUNEOztBQUNELFVBQU0sSUFBSWYsS0FBSyxDQUFDSSxLQUFWLENBQWdCSixLQUFLLENBQUNJLEtBQU4sQ0FBWVksZ0JBQTVCLEVBQThDLHdDQUE5QyxDQUFOO0FBQ0QsR0FMTSxDQUFQO0FBTUQsQyxDQUVEOzs7QUFDQSxTQUFTQyxhQUFULEdBQXlCO0FBQ3ZCLFNBQU9DLE9BQU8sQ0FBQ0MsT0FBUixFQUFQO0FBQ0Q7O0FBRUQsU0FBU2IsNEJBQVQsQ0FBc0NKLFFBQXRDLEVBQWdEQyxPQUFoRCxFQUF5RDtBQUN2RCxNQUFJaUIsS0FBSyxDQUFDQyxPQUFOLENBQWNsQixPQUFkLENBQUosRUFBNEI7QUFDMUIsVUFBTW1CLFlBQVksR0FBR3BCLFFBQVEsQ0FBQ29CLFlBQTlCOztBQUNBLFFBQUksQ0FBQ0EsWUFBTCxFQUFtQjtBQUNqQixZQUFNLElBQUl0QixLQUFLLENBQUNJLEtBQVYsQ0FBZ0JKLEtBQUssQ0FBQ0ksS0FBTixDQUFZWSxnQkFBNUIsRUFBOEMsd0NBQTlDLENBQU47QUFDRDs7QUFDRGIsSUFBQUEsT0FBTyxHQUFHQSxPQUFPLENBQUNvQixNQUFSLENBQWVDLE1BQU0sSUFBSTtBQUNqQyxhQUFPQSxNQUFNLENBQUNGLFlBQVAsSUFBdUJBLFlBQTlCO0FBQ0QsS0FGUyxDQUFWOztBQUlBLFFBQUluQixPQUFPLENBQUNzQixNQUFSLElBQWtCLENBQXRCLEVBQXlCO0FBQ3ZCLFlBQU0sSUFBSXpCLEtBQUssQ0FBQ0ksS0FBVixDQUFnQkosS0FBSyxDQUFDSSxLQUFOLENBQVlZLGdCQUE1QixFQUE4Qyx3Q0FBOUMsQ0FBTjtBQUNEOztBQUNEYixJQUFBQSxPQUFPLEdBQUdBLE9BQU8sQ0FBQyxDQUFELENBQWpCO0FBQ0Q7O0FBQ0QsU0FBT0EsT0FBUDtBQUNEOztBQUVEdUIsTUFBTSxDQUFDQyxPQUFQLEdBQWlCO0FBQ2ZWLEVBQUFBLGFBRGU7QUFFZmhCLEVBQUFBLGdCQUZlO0FBR2ZLLEVBQUFBO0FBSGUsQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBIZWxwZXIgZnVuY3Rpb25zIGZvciBhY2Nlc3NpbmcgdGhlIHR3aXR0ZXIgQVBJLlxudmFyIE9BdXRoID0gcmVxdWlyZSgnLi9PQXV0aDFDbGllbnQnKTtcbnZhciBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZTtcblxuLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCBmdWxmaWxscyBpZmYgdGhpcyB1c2VyIGlkIGlzIHZhbGlkLlxuZnVuY3Rpb24gdmFsaWRhdGVBdXRoRGF0YShhdXRoRGF0YSwgb3B0aW9ucykge1xuICBpZiAoIW9wdGlvbnMpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCAnVHdpdHRlciBhdXRoIGNvbmZpZ3VyYXRpb24gbWlzc2luZycpO1xuICB9XG4gIG9wdGlvbnMgPSBoYW5kbGVNdWx0aXBsZUNvbmZpZ3VyYXRpb25zKGF1dGhEYXRhLCBvcHRpb25zKTtcbiAgdmFyIGNsaWVudCA9IG5ldyBPQXV0aChvcHRpb25zKTtcbiAgY2xpZW50Lmhvc3QgPSAnYXBpLnR3aXR0ZXIuY29tJztcbiAgY2xpZW50LmF1dGhfdG9rZW4gPSBhdXRoRGF0YS5hdXRoX3Rva2VuO1xuICBjbGllbnQuYXV0aF90b2tlbl9zZWNyZXQgPSBhdXRoRGF0YS5hdXRoX3Rva2VuX3NlY3JldDtcblxuICByZXR1cm4gY2xpZW50LmdldCgnLzEuMS9hY2NvdW50L3ZlcmlmeV9jcmVkZW50aWFscy5qc29uJykudGhlbihkYXRhID0+IHtcbiAgICBpZiAoZGF0YSAmJiBkYXRhLmlkX3N0ciA9PSAnJyArIGF1dGhEYXRhLmlkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnVHdpdHRlciBhdXRoIGlzIGludmFsaWQgZm9yIHRoaXMgdXNlci4nKTtcbiAgfSk7XG59XG5cbi8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgZnVsZmlsbHMgaWZmIHRoaXMgYXBwIGlkIGlzIHZhbGlkLlxuZnVuY3Rpb24gdmFsaWRhdGVBcHBJZCgpIHtcbiAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVNdWx0aXBsZUNvbmZpZ3VyYXRpb25zKGF1dGhEYXRhLCBvcHRpb25zKSB7XG4gIGlmIChBcnJheS5pc0FycmF5KG9wdGlvbnMpKSB7XG4gICAgY29uc3QgY29uc3VtZXJfa2V5ID0gYXV0aERhdGEuY29uc3VtZXJfa2V5O1xuICAgIGlmICghY29uc3VtZXJfa2V5KSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ1R3aXR0ZXIgYXV0aCBpcyBpbnZhbGlkIGZvciB0aGlzIHVzZXIuJyk7XG4gICAgfVxuICAgIG9wdGlvbnMgPSBvcHRpb25zLmZpbHRlcihvcHRpb24gPT4ge1xuICAgICAgcmV0dXJuIG9wdGlvbi5jb25zdW1lcl9rZXkgPT0gY29uc3VtZXJfa2V5O1xuICAgIH0pO1xuXG4gICAgaWYgKG9wdGlvbnMubGVuZ3RoID09IDApIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELCAnVHdpdHRlciBhdXRoIGlzIGludmFsaWQgZm9yIHRoaXMgdXNlci4nKTtcbiAgICB9XG4gICAgb3B0aW9ucyA9IG9wdGlvbnNbMF07XG4gIH1cbiAgcmV0dXJuIG9wdGlvbnM7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICB2YWxpZGF0ZUFwcElkLFxuICB2YWxpZGF0ZUF1dGhEYXRhLFxuICBoYW5kbGVNdWx0aXBsZUNvbmZpZ3VyYXRpb25zLFxufTtcbiJdfQ==