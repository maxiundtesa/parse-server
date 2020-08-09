"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.load = void 0;

var _graphql = require("graphql");

var _graphqlRelay = require("graphql-relay");

var _UsersRouter = _interopRequireDefault(require("../../Routers/UsersRouter"));

var objectsMutations = _interopRequireWildcard(require("../helpers/objectsMutations"));

var _defaultGraphQLTypes = require("./defaultGraphQLTypes");

var _usersQueries = require("./usersQueries");

function _getRequireWildcardCache() { if (typeof WeakMap !== "function") return null; var cache = new WeakMap(); _getRequireWildcardCache = function () { return cache; }; return cache; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const usersRouter = new _UsersRouter.default();

const load = parseGraphQLSchema => {
  if (parseGraphQLSchema.isUsersClassDisabled) {
    return;
  }

  const signUpMutation = (0, _graphqlRelay.mutationWithClientMutationId)({
    name: 'SignUp',
    description: 'The signUp mutation can be used to create and sign up a new user.',
    inputFields: {
      fields: {
        descriptions: 'These are the fields of the new user to be created and signed up.',
        type: parseGraphQLSchema.parseClassTypes['_User'].classGraphQLCreateType
      }
    },
    outputFields: {
      viewer: {
        description: 'This is the new user that was created, signed up and returned as a viewer.',
        type: new _graphql.GraphQLNonNull(parseGraphQLSchema.viewerType)
      }
    },
    mutateAndGetPayload: async (args, context, mutationInfo) => {
      try {
        const {
          fields
        } = args;
        const {
          config,
          auth,
          info
        } = context;
        const {
          sessionToken
        } = await objectsMutations.createObject('_User', fields, config, auth, info);
        info.sessionToken = sessionToken;
        return {
          viewer: await (0, _usersQueries.getUserFromSessionToken)(config, info, mutationInfo, 'viewer.user.', true)
        };
      } catch (e) {
        parseGraphQLSchema.handleError(e);
      }
    }
  });
  parseGraphQLSchema.addGraphQLType(signUpMutation.args.input.type.ofType, true, true);
  parseGraphQLSchema.addGraphQLType(signUpMutation.type, true, true);
  parseGraphQLSchema.addGraphQLMutation('signUp', signUpMutation, true, true);
  const logInWithMutation = (0, _graphqlRelay.mutationWithClientMutationId)({
    name: 'LogInWith',
    description: 'The logInWith mutation can be used to signup, login user with 3rd party authentication system. This mutation create a user if the authData do not correspond to an existing one.',
    inputFields: {
      authData: {
        descriptions: 'This is the auth data of your custom auth provider',
        type: new _graphql.GraphQLNonNull(_defaultGraphQLTypes.OBJECT)
      },
      fields: {
        descriptions: 'These are the fields of the user to be created/updated and logged in.',
        type: new _graphql.GraphQLInputObjectType({
          name: 'UserLoginWithInput',
          fields: () => {
            const classGraphQLCreateFields = parseGraphQLSchema.parseClassTypes['_User'].classGraphQLCreateType.getFields();
            return Object.keys(classGraphQLCreateFields).reduce((fields, fieldName) => {
              if (fieldName !== 'password' && fieldName !== 'username' && fieldName !== 'authData') {
                fields[fieldName] = classGraphQLCreateFields[fieldName];
              }

              return fields;
            }, {});
          }
        })
      }
    },
    outputFields: {
      viewer: {
        description: 'This is the new user that was created, signed up and returned as a viewer.',
        type: new _graphql.GraphQLNonNull(parseGraphQLSchema.viewerType)
      }
    },
    mutateAndGetPayload: async (args, context, mutationInfo) => {
      try {
        const {
          fields,
          authData
        } = args;
        const {
          config,
          auth,
          info
        } = context;
        const {
          sessionToken
        } = await objectsMutations.createObject('_User', _objectSpread({}, fields, {
          authData
        }), config, auth, info);
        info.sessionToken = sessionToken;
        return {
          viewer: await (0, _usersQueries.getUserFromSessionToken)(config, info, mutationInfo, 'viewer.user.', true)
        };
      } catch (e) {
        parseGraphQLSchema.handleError(e);
      }
    }
  });
  parseGraphQLSchema.addGraphQLType(logInWithMutation.args.input.type.ofType, true, true);
  parseGraphQLSchema.addGraphQLType(logInWithMutation.type, true, true);
  parseGraphQLSchema.addGraphQLMutation('logInWith', logInWithMutation, true, true);
  const logInMutation = (0, _graphqlRelay.mutationWithClientMutationId)({
    name: 'LogIn',
    description: 'The logIn mutation can be used to log in an existing user.',
    inputFields: {
      username: {
        description: 'This is the username used to log in the user.',
        type: new _graphql.GraphQLNonNull(_graphql.GraphQLString)
      },
      password: {
        description: 'This is the password used to log in the user.',
        type: new _graphql.GraphQLNonNull(_graphql.GraphQLString)
      }
    },
    outputFields: {
      viewer: {
        description: 'This is the existing user that was logged in and returned as a viewer.',
        type: new _graphql.GraphQLNonNull(parseGraphQLSchema.viewerType)
      }
    },
    mutateAndGetPayload: async (args, context, mutationInfo) => {
      try {
        const {
          username,
          password
        } = args;
        const {
          config,
          auth,
          info
        } = context;
        const {
          sessionToken
        } = (await usersRouter.handleLogIn({
          body: {
            username,
            password
          },
          query: {},
          config,
          auth,
          info
        })).response;
        info.sessionToken = sessionToken;
        return {
          viewer: await (0, _usersQueries.getUserFromSessionToken)(config, info, mutationInfo, 'viewer.user.', true)
        };
      } catch (e) {
        parseGraphQLSchema.handleError(e);
      }
    }
  });
  parseGraphQLSchema.addGraphQLType(logInMutation.args.input.type.ofType, true, true);
  parseGraphQLSchema.addGraphQLType(logInMutation.type, true, true);
  parseGraphQLSchema.addGraphQLMutation('logIn', logInMutation, true, true);
  const logOutMutation = (0, _graphqlRelay.mutationWithClientMutationId)({
    name: 'LogOut',
    description: 'The logOut mutation can be used to log out an existing user.',
    outputFields: {
      viewer: {
        description: 'This is the existing user that was logged out and returned as a viewer.',
        type: new _graphql.GraphQLNonNull(parseGraphQLSchema.viewerType)
      }
    },
    mutateAndGetPayload: async (_args, context, mutationInfo) => {
      try {
        const {
          config,
          auth,
          info
        } = context;
        const viewer = await (0, _usersQueries.getUserFromSessionToken)(config, info, mutationInfo, 'viewer.user.', true);
        await usersRouter.handleLogOut({
          config,
          auth,
          info
        });
        return {
          viewer
        };
      } catch (e) {
        parseGraphQLSchema.handleError(e);
      }
    }
  });
  parseGraphQLSchema.addGraphQLType(logOutMutation.args.input.type.ofType, true, true);
  parseGraphQLSchema.addGraphQLType(logOutMutation.type, true, true);
  parseGraphQLSchema.addGraphQLMutation('logOut', logOutMutation, true, true);
  const resetPasswordMutation = (0, _graphqlRelay.mutationWithClientMutationId)({
    name: 'ResetPassword',
    description: 'The resetPassword mutation can be used to reset the password of an existing user.',
    inputFields: {
      email: {
        descriptions: 'Email of the user that should receive the reset email',
        type: new _graphql.GraphQLNonNull(_graphql.GraphQLString)
      }
    },
    outputFields: {
      ok: {
        description: "It's always true.",
        type: new _graphql.GraphQLNonNull(_graphql.GraphQLBoolean)
      }
    },
    mutateAndGetPayload: async ({
      email
    }, context) => {
      const {
        config,
        auth,
        info
      } = context;
      await usersRouter.handleResetRequest({
        body: {
          email
        },
        config,
        auth,
        info
      });
      return {
        ok: true
      };
    }
  });
  parseGraphQLSchema.addGraphQLType(resetPasswordMutation.args.input.type.ofType, true, true);
  parseGraphQLSchema.addGraphQLType(resetPasswordMutation.type, true, true);
  parseGraphQLSchema.addGraphQLMutation('resetPassword', resetPasswordMutation, true, true);
  const sendVerificationEmailMutation = (0, _graphqlRelay.mutationWithClientMutationId)({
    name: 'SendVerificationEmail',
    description: 'The sendVerificationEmail mutation can be used to send the verification email again.',
    inputFields: {
      email: {
        descriptions: 'Email of the user that should receive the verification email',
        type: new _graphql.GraphQLNonNull(_graphql.GraphQLString)
      }
    },
    outputFields: {
      ok: {
        description: "It's always true.",
        type: new _graphql.GraphQLNonNull(_graphql.GraphQLBoolean)
      }
    },
    mutateAndGetPayload: async ({
      email
    }, context) => {
      try {
        const {
          config,
          auth,
          info
        } = context;
        await usersRouter.handleVerificationEmailRequest({
          body: {
            email
          },
          config,
          auth,
          info
        });
        return {
          ok: true
        };
      } catch (e) {
        parseGraphQLSchema.handleError(e);
      }
    }
  });
  parseGraphQLSchema.addGraphQLType(sendVerificationEmailMutation.args.input.type.ofType, true, true);
  parseGraphQLSchema.addGraphQLType(sendVerificationEmailMutation.type, true, true);
  parseGraphQLSchema.addGraphQLMutation('sendVerificationEmail', sendVerificationEmailMutation, true, true);
};

exports.load = load;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2xvYWRlcnMvdXNlcnNNdXRhdGlvbnMuanMiXSwibmFtZXMiOlsidXNlcnNSb3V0ZXIiLCJVc2Vyc1JvdXRlciIsImxvYWQiLCJwYXJzZUdyYXBoUUxTY2hlbWEiLCJpc1VzZXJzQ2xhc3NEaXNhYmxlZCIsInNpZ25VcE11dGF0aW9uIiwibmFtZSIsImRlc2NyaXB0aW9uIiwiaW5wdXRGaWVsZHMiLCJmaWVsZHMiLCJkZXNjcmlwdGlvbnMiLCJ0eXBlIiwicGFyc2VDbGFzc1R5cGVzIiwiY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZSIsIm91dHB1dEZpZWxkcyIsInZpZXdlciIsIkdyYXBoUUxOb25OdWxsIiwidmlld2VyVHlwZSIsIm11dGF0ZUFuZEdldFBheWxvYWQiLCJhcmdzIiwiY29udGV4dCIsIm11dGF0aW9uSW5mbyIsImNvbmZpZyIsImF1dGgiLCJpbmZvIiwic2Vzc2lvblRva2VuIiwib2JqZWN0c011dGF0aW9ucyIsImNyZWF0ZU9iamVjdCIsImUiLCJoYW5kbGVFcnJvciIsImFkZEdyYXBoUUxUeXBlIiwiaW5wdXQiLCJvZlR5cGUiLCJhZGRHcmFwaFFMTXV0YXRpb24iLCJsb2dJbldpdGhNdXRhdGlvbiIsImF1dGhEYXRhIiwiT0JKRUNUIiwiR3JhcGhRTElucHV0T2JqZWN0VHlwZSIsImNsYXNzR3JhcGhRTENyZWF0ZUZpZWxkcyIsImdldEZpZWxkcyIsIk9iamVjdCIsImtleXMiLCJyZWR1Y2UiLCJmaWVsZE5hbWUiLCJsb2dJbk11dGF0aW9uIiwidXNlcm5hbWUiLCJHcmFwaFFMU3RyaW5nIiwicGFzc3dvcmQiLCJoYW5kbGVMb2dJbiIsImJvZHkiLCJxdWVyeSIsInJlc3BvbnNlIiwibG9nT3V0TXV0YXRpb24iLCJfYXJncyIsImhhbmRsZUxvZ091dCIsInJlc2V0UGFzc3dvcmRNdXRhdGlvbiIsImVtYWlsIiwib2siLCJHcmFwaFFMQm9vbGVhbiIsImhhbmRsZVJlc2V0UmVxdWVzdCIsInNlbmRWZXJp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RDtBQWlCakV4QyxJQUFBQSxtQkFBbUIsRUFBRSxPQUFPO0FBQUVzQyxNQUFBQTtBQUFGLEtBQVAsRUFBa0JwQyxPQUFsQixLQUE4QjtBQUNqRCxVQUFJO0FBQ0YsY0FBTTtBQUFFRSxVQUFBQSxNQUFGO0FBQVVDLFVBQUFBLElBQVY7QUFBZ0JDLFVBQUFBO0FBQWhCLFlBQXlCSixPQUEvQjtBQUVBLGNBQU1wQixXQUFXLENBQUM2RCw4QkFBWixDQUEyQztBQUMvQ1osVUFBQUEsSUFBSSxFQUFFO0FBQ0pPLFlBQUFBO0FBREksV0FEeUM7QUFJL0NsQyxVQUFBQSxNQUorQztBQUsvQ0MsVUFBQUEsSUFMK0M7QUFNL0NDLFVBQUFBO0FBTitDLFNBQTNDLENBQU47QUFTQSxlQUFPO0FBQUVpQyxVQUFBQSxFQUFFLEVBQUU7QUFBTixTQUFQO0FBQ0QsT0FiRCxDQWFFLE9BQU83QixDQUFQLEVBQVU7QUFDVnpCLFFBQUFBLGtCQUFrQixDQUFDMEIsV0FBbkIsQ0FBK0JELENBQS9CO0FBQ0Q7QUFDRjtBQWxDZ0UsR0FBN0IsQ0FBdEM7QUFxQ0F6QixFQUFBQSxrQkFBa0IsQ0FBQzJCLGNBQW5CLENBQ0U4Qiw2QkFBNkIsQ0FBQ3pDLElBQTlCLENBQW1DWSxLQUFuQyxDQUF5Q3BCLElBQXpDLENBQThDcUIsTUFEaEQsRUFFRSxJQUZGLEVBR0UsSUFIRjtBQUtBN0IsRUFBQUEsa0JBQWtCLENBQUMyQixjQUFuQixDQUNFOEIsNkJBQTZCLENBQUNqRCxJQURoQyxFQUVFLElBRkYsRUFHRSxJQUhGO0FBS0FSLEVBQUFBLGtCQUFrQixDQUFDOEIsa0JBQW5CLENBQ0UsdUJBREYsRUFFRTJCLDZCQUZGLEVBR0UsSUFIRixFQUlFLElBSkY7QUFNRCxDQTVWRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7XG4gIEdyYXBoUUxOb25OdWxsLFxuICBHcmFwaFFMU3RyaW5nLFxuICBHcmFwaFFMQm9vbGVhbixcbiAgR3JhcGhRTElucHV0T2JqZWN0VHlwZSxcbn0gZnJvbSAnZ3JhcGhxbCc7XG5pbXBvcnQgeyBtdXRhdGlvbldpdGhDbGllbnRNdXRhdGlvbklkIH0gZnJvbSAnZ3JhcGhxbC1yZWxheSc7XG5pbXBvcnQgVXNlcnNSb3V0ZXIgZnJvbSAnLi4vLi4vUm91dGVycy9Vc2Vyc1JvdXRlcic7XG5pbXBvcnQgKiBhcyBvYmplY3RzTXV0YXRpb25zIGZyb20gJy4uL2hlbHBlcnMvb2JqZWN0c011dGF0aW9ucyc7XG5pbXBvcnQgeyBPQkpFQ1QgfSBmcm9tICcuL2RlZmF1bHRHcmFwaFFMVHlwZXMnO1xuaW1wb3J0IHsgZ2V0VXNlckZyb21TZXNzaW9uVG9rZW4gfSBmcm9tICcuL3VzZXJzUXVlcmllcyc7XG5cbmNvbnN0IHVzZXJzUm91dGVyID0gbmV3IFVzZXJzUm91dGVyKCk7XG5cbmNvbnN0IGxvYWQgPSBwYXJzZUdyYXBoUUxTY2hlbWEgPT4ge1xuICBpZiAocGFyc2VHcmFwaFFMU2NoZW1hLmlzVXNlcnNDbGFzc0Rpc2FibGVkKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgc2lnblVwTXV0YXRpb24gPSBtdXRhdGlvbldpdGhDbGllbnRNdXRhdGlvbklkKHtcbiAgICBuYW1lOiAnU2lnblVwJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdUaGUgc2lnblVwIG11dGF0aW9uIGNhbiBiZSB1c2VkIHRvIGNyZWF0ZSBhbmQgc2lnbiB1cCBhIG5ldyB1c2VyLicsXG4gICAgaW5wdXRGaWVsZHM6IHtcbiAgICAgIGZpZWxkczoge1xuICAgICAgICBkZXNjcmlwdGlvbnM6XG4gICAgICAgICAgJ1RoZXNlIGFyZSB0aGUgZmllbGRzIG9mIHRoZSBuZXcgdXNlciB0byBiZSBjcmVhdGVkIGFuZCBzaWduZWQgdXAuJyxcbiAgICAgICAgdHlwZTpcbiAgICAgICAgICBwYXJzZUdyYXBoUUxTY2hlbWEucGFyc2VDbGFzc1R5cGVzWydfVXNlciddLmNsYXNzR3JhcGhRTENyZWF0ZVR5cGUsXG4gICAgICB9LFxuICAgIH0sXG4gICAgb3V0cHV0RmllbGRzOiB7XG4gICAgICB2aWV3ZXI6IHtcbiAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgJ1RoaXMgaXMgdGhlIG5ldyB1c2VyIHRoYXQgd2FzIGNyZWF0ZWQsIHNpZ25lZCB1cCBhbmQgcmV0dXJuZWQgYXMgYSB2aWV3ZXIuJyxcbiAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKHBhcnNlR3JhcGhRTFNjaGVtYS52aWV3ZXJUeXBlKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBtdXRhdGVBbmRHZXRQYXlsb2FkOiBhc3luYyAoYXJncywgY29udGV4dCwgbXV0YXRpb25JbmZvKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB7IGZpZWxkcyB9ID0gYXJncztcbiAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgY29uc3QgeyBzZXNzaW9uVG9rZW4gfSA9IGF3YWl0IG9iamVjdHNNdXRhdGlvbnMuY3JlYXRlT2JqZWN0KFxuICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgZmllbGRzLFxuICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIGluZm9cbiAgICAgICAgKTtcblxuICAgICAgICBpbmZvLnNlc3Npb25Ub2tlbiA9IHNlc3Npb25Ub2tlbjtcblxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHZpZXdlcjogYXdhaXQgZ2V0VXNlckZyb21TZXNzaW9uVG9rZW4oXG4gICAgICAgICAgICBjb25maWcsXG4gICAgICAgICAgICBpbmZvLFxuICAgICAgICAgICAgbXV0YXRpb25JbmZvLFxuICAgICAgICAgICAgJ3ZpZXdlci51c2VyLicsXG4gICAgICAgICAgICB0cnVlXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcGFyc2VHcmFwaFFMU2NoZW1hLmhhbmRsZUVycm9yKGUpO1xuICAgICAgfVxuICAgIH0sXG4gIH0pO1xuXG4gIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShcbiAgICBzaWduVXBNdXRhdGlvbi5hcmdzLmlucHV0LnR5cGUub2ZUeXBlLFxuICAgIHRydWUsXG4gICAgdHJ1ZVxuICApO1xuICBwYXJzZUdyYXBoUUxTY2hlbWEuYWRkR3JhcGhRTFR5cGUoc2lnblVwTXV0YXRpb24udHlwZSwgdHJ1ZSwgdHJ1ZSk7XG4gIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMTXV0YXRpb24oJ3NpZ25VcCcsIHNpZ25VcE11dGF0aW9uLCB0cnVlLCB0cnVlKTtcbiAgY29uc3QgbG9nSW5XaXRoTXV0YXRpb24gPSBtdXRhdGlvbldpdGhDbGllbnRNdXRhdGlvbklkKHtcbiAgICBuYW1lOiAnTG9nSW5XaXRoJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdUaGUgbG9nSW5XaXRoIG11dGF0aW9uIGNhbiBiZSB1c2VkIHRvIHNpZ251cCwgbG9naW4gdXNlciB3aXRoIDNyZCBwYXJ0eSBhdXRoZW50aWNhdGlvbiBzeXN0ZW0uIFRoaXMgbXV0YXRpb24gY3JlYXRlIGEgdXNlciBpZiB0aGUgYXV0aERhdGEgZG8gbm90IGNvcnJlc3BvbmQgdG8gYW4gZXhpc3Rpbmcgb25lLicsXG4gICAgaW5wdXRGaWVsZHM6IHtcbiAgICAgIGF1dGhEYXRhOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uczogJ1RoaXMgaXMgdGhlIGF1dGggZGF0YSBvZiB5b3VyIGN1c3RvbSBhdXRoIHByb3ZpZGVyJyxcbiAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKE9CSkVDVCksXG4gICAgICB9LFxuICAgICAgZmllbGRzOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uczpcbiAgICAgICAgICAnVGhlc2UgYXJlIHRoZSBmaWVsZHMgb2YgdGhlIHVzZXIgdG8gYmUgY3JlYXRlZC91cGRhdGVkIGFuZCBsb2dnZWQgaW4uJyxcbiAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxJbnB1dE9iamVjdFR5cGUoe1xuICAgICAgICAgIG5hbWU6ICdVc2VyTG9naW5XaXRoSW5wdXQnLFxuICAgICAgICAgIGZpZWxkczogKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2xhc3NHcmFwaFFMQ3JlYXRlRmllbGRzID0gcGFyc2VHcmFwaFFMU2NoZW1hLnBhcnNlQ2xhc3NUeXBlc1tcbiAgICAgICAgICAgICAgJ19Vc2VyJ1xuICAgICAgICAgICAgXS5jbGFzc0dyYXBoUUxDcmVhdGVUeXBlLmdldEZpZWxkcygpO1xuICAgICAgICAgICAgcmV0dXJuIE9iamVjdC5rZXlzKGNsYXNzR3JhcGhRTENyZWF0ZUZpZWxkcykucmVkdWNlKFxuICAgICAgICAgICAgICAoZmllbGRzLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICBmaWVsZE5hbWUgIT09ICdwYXNzd29yZCcgJiZcbiAgICAgICAgICAgICAgICAgIGZpZWxkTmFtZSAhPT0gJ3VzZXJuYW1lJyAmJlxuICAgICAgICAgICAgICAgICAgZmllbGROYW1lICE9PSAnYXV0aERhdGEnXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICBmaWVsZHNbZmllbGROYW1lXSA9IGNsYXNzR3JhcGhRTENyZWF0ZUZpZWxkc1tmaWVsZE5hbWVdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gZmllbGRzO1xuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB7fVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9LFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBvdXRwdXRGaWVsZHM6IHtcbiAgICAgIHZpZXdlcjoge1xuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICAnVGhpcyBpcyB0aGUgbmV3IHVzZXIgdGhhdCB3YXMgY3JlYXRlZCwgc2lnbmVkIHVwIGFuZCByZXR1cm5lZCBhcyBhIHZpZXdlci4nLFxuICAgICAgICB0eXBlOiBuZXcgR3JhcGhRTE5vbk51bGwocGFyc2VHcmFwaFFMU2NoZW1hLnZpZXdlclR5cGUpLFxuICAgICAgfSxcbiAgICB9LFxuICAgIG11dGF0ZUFuZEdldFBheWxvYWQ6IGFzeW5jIChhcmdzLCBjb250ZXh0LCBtdXRhdGlvbkluZm8pID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgZmllbGRzLCBhdXRoRGF0YSB9ID0gYXJncztcbiAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgY29uc3QgeyBzZXNzaW9uVG9rZW4gfSA9IGF3YWl0IG9iamVjdHNNdXRhdGlvbnMuY3JlYXRlT2JqZWN0KFxuICAgICAgICAgICdfVXNlcicsXG4gICAgICAgICAgeyAuLi5maWVsZHMsIGF1dGhEYXRhIH0sXG4gICAgICAgICAgY29uZmlnLFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgaW5mb1xuICAgICAgICApO1xuXG4gICAgICAgIGluZm8uc2Vzc2lvblRva2VuID0gc2Vzc2lvblRva2VuO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdmlld2VyOiBhd2FpdCBnZXRVc2VyRnJvbVNlc3Npb25Ub2tlbihcbiAgICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICAgIGluZm8sXG4gICAgICAgICAgICBtdXRhdGlvbkluZm8sXG4gICAgICAgICAgICAndmlld2VyLnVzZXIuJyxcbiAgICAgICAgICAgIHRydWVcbiAgICAgICAgICApLFxuICAgICAgICB9O1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBwYXJzZUdyYXBoUUxTY2hlbWEuaGFuZGxlRXJyb3IoZSk7XG4gICAgICB9XG4gICAgfSxcbiAgfSk7XG5cbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgIGxvZ0luV2l0aE11dGF0aW9uLmFyZ3MuaW5wdXQudHlwZS5vZlR5cGUsXG4gICAgdHJ1ZSxcbiAgICB0cnVlXG4gICk7XG4gIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShsb2dJbldpdGhNdXRhdGlvbi50eXBlLCB0cnVlLCB0cnVlKTtcbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxNdXRhdGlvbihcbiAgICAnbG9nSW5XaXRoJyxcbiAgICBsb2dJbldpdGhNdXRhdGlvbixcbiAgICB0cnVlLFxuICAgIHRydWVcbiAgKTtcblxuICBjb25zdCBsb2dJbk11dGF0aW9uID0gbXV0YXRpb25XaXRoQ2xpZW50TXV0YXRpb25JZCh7XG4gICAgbmFtZTogJ0xvZ0luJyxcbiAgICBkZXNjcmlwdGlvbjogJ1RoZSBsb2dJbiBtdXRhdGlvbiBjYW4gYmUgdXNlZCB0byBsb2cgaW4gYW4gZXhpc3RpbmcgdXNlci4nLFxuICAgIGlucHV0RmllbGRzOiB7XG4gICAgICB1c2VybmFtZToge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ1RoaXMgaXMgdGhlIHVzZXJuYW1lIHVzZWQgdG8gbG9nIGluIHRoZSB1c2VyLicsXG4gICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChHcmFwaFFMU3RyaW5nKSxcbiAgICAgIH0sXG4gICAgICBwYXNzd29yZDoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ1RoaXMgaXMgdGhlIHBhc3N3b3JkIHVzZWQgdG8gbG9nIGluIHRoZSB1c2VyLicsXG4gICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChHcmFwaFFMU3RyaW5nKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBvdXRwdXRGaWVsZHM6IHtcbiAgICAgIHZpZXdlcjoge1xuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICAnVGhpcyBpcyB0aGUgZXhpc3RpbmcgdXNlciB0aGF0IHdhcyBsb2dnZWQgaW4gYW5kIHJldHVybmVkIGFzIGEgdmlld2VyLicsXG4gICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChwYXJzZUdyYXBoUUxTY2hlbWEudmlld2VyVHlwZSksXG4gICAgICB9LFxuICAgIH0sXG4gICAgbXV0YXRlQW5kR2V0UGF5bG9hZDogYXN5bmMgKGFyZ3MsIGNvbnRleHQsIG11dGF0aW9uSW5mbykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyB1c2VybmFtZSwgcGFzc3dvcmQgfSA9IGFyZ3M7XG4gICAgICAgIGNvbnN0IHsgY29uZmlnLCBhdXRoLCBpbmZvIH0gPSBjb250ZXh0O1xuXG4gICAgICAgIGNvbnN0IHsgc2Vzc2lvblRva2VuIH0gPSAoYXdhaXQgdXNlcnNSb3V0ZXIuaGFuZGxlTG9nSW4oe1xuICAgICAgICAgIGJvZHk6IHtcbiAgICAgICAgICAgIHVzZXJuYW1lLFxuICAgICAgICAgICAgcGFzc3dvcmQsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBxdWVyeToge30sXG4gICAgICAgICAgY29uZmlnLFxuICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgaW5mbyxcbiAgICAgICAgfSkpLnJlc3BvbnNlO1xuXG4gICAgICAgIGluZm8uc2Vzc2lvblRva2VuID0gc2Vzc2lvblRva2VuO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdmlld2VyOiBhd2FpdCBnZXRVc2VyRnJvbVNlc3Npb25Ub2tlbihcbiAgICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICAgIGluZm8sXG4gICAgICAgICAgICBtdXRhdGlvbkluZm8sXG4gICAgICAgICAgICAndmlld2VyLnVzZXIuJyxcbiAgICAgICAgICAgIHRydWVcbiAgICAgICAgICApLFxuICAgICAgICB9O1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBwYXJzZUdyYXBoUUxTY2hlbWEuaGFuZGxlRXJyb3IoZSk7XG4gICAgICB9XG4gICAgfSxcbiAgfSk7XG5cbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgIGxvZ0luTXV0YXRpb24uYXJncy5pbnB1dC50eXBlLm9mVHlwZSxcbiAgICB0cnVlLFxuICAgIHRydWVcbiAgKTtcbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKGxvZ0luTXV0YXRpb24udHlwZSwgdHJ1ZSwgdHJ1ZSk7XG4gIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMTXV0YXRpb24oJ2xvZ0luJywgbG9nSW5NdXRhdGlvbiwgdHJ1ZSwgdHJ1ZSk7XG5cbiAgY29uc3QgbG9nT3V0TXV0YXRpb24gPSBtdXRhdGlvbldpdGhDbGllbnRNdXRhdGlvbklkKHtcbiAgICBuYW1lOiAnTG9nT3V0JyxcbiAgICBkZXNjcmlwdGlvbjogJ1RoZSBsb2dPdXQgbXV0YXRpb24gY2FuIGJlIHVzZWQgdG8gbG9nIG91dCBhbiBleGlzdGluZyB1c2VyLicsXG4gICAgb3V0cHV0RmllbGRzOiB7XG4gICAgICB2aWV3ZXI6IHtcbiAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgJ1RoaXMgaXMgdGhlIGV4aXN0aW5nIHVzZXIgdGhhdCB3YXMgbG9nZ2VkIG91dCBhbmQgcmV0dXJuZWQgYXMgYSB2aWV3ZXIuJyxcbiAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKHBhcnNlR3JhcGhRTFNjaGVtYS52aWV3ZXJUeXBlKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBtdXRhdGVBbmRHZXRQYXlsb2FkOiBhc3luYyAoX2FyZ3MsIGNvbnRleHQsIG11dGF0aW9uSW5mbykgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgY29uc3Qgdmlld2VyID0gYXdhaXQgZ2V0VXNlckZyb21TZXNzaW9uVG9rZW4oXG4gICAgICAgICAgY29uZmlnLFxuICAgICAgICAgIGluZm8sXG4gICAgICAgICAgbXV0YXRpb25JbmZvLFxuICAgICAgICAgICd2aWV3ZXIudXNlci4nLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKTtcblxuICAgICAgICBhd2FpdCB1c2Vyc1JvdXRlci5oYW5kbGVMb2dPdXQoe1xuICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIGluZm8sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiB7IHZpZXdlciB9O1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBwYXJzZUdyYXBoUUxTY2hlbWEuaGFuZGxlRXJyb3IoZSk7XG4gICAgICB9XG4gICAgfSxcbiAgfSk7XG5cbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgIGxvZ091dE11dGF0aW9uLmFyZ3MuaW5wdXQudHlwZS5vZlR5cGUsXG4gICAgdHJ1ZSxcbiAgICB0cnVlXG4gICk7XG4gIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShsb2dPdXRNdXRhdGlvbi50eXBlLCB0cnVlLCB0cnVlKTtcbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxNdXRhdGlvbignbG9nT3V0JywgbG9nT3V0TXV0YXRpb24sIHRydWUsIHRydWUpO1xuXG4gIGNvbnN0IHJlc2V0UGFzc3dvcmRNdXRhdGlvbiA9IG11dGF0aW9uV2l0aENsaWVudE11dGF0aW9uSWQoe1xuICAgIG5hbWU6ICdSZXNldFBhc3N3b3JkJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdUaGUgcmVzZXRQYXNzd29yZCBtdXRhdGlvbiBjYW4gYmUgdXNlZCB0byByZXNldCB0aGUgcGFzc3dvcmQgb2YgYW4gZXhpc3RpbmcgdXNlci4nLFxuICAgIGlucHV0RmllbGRzOiB7XG4gICAgICBlbWFpbDoge1xuICAgICAgICBkZXNjcmlwdGlvbnM6ICdFbWFpbCBvZiB0aGUgdXNlciB0aGF0IHNob3VsZCByZWNlaXZlIHRoZSByZXNldCBlbWFpbCcsXG4gICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChHcmFwaFFMU3RyaW5nKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBvdXRwdXRGaWVsZHM6IHtcbiAgICAgIG9rOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIkl0J3MgYWx3YXlzIHRydWUuXCIsXG4gICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChHcmFwaFFMQm9vbGVhbiksXG4gICAgICB9LFxuICAgIH0sXG4gICAgbXV0YXRlQW5kR2V0UGF5bG9hZDogYXN5bmMgKHsgZW1haWwgfSwgY29udGV4dCkgPT4ge1xuICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgIGF3YWl0IHVzZXJzUm91dGVyLmhhbmRsZVJlc2V0UmVxdWVzdCh7XG4gICAgICAgIGJvZHk6IHtcbiAgICAgICAgICBlbWFpbCxcbiAgICAgICAgfSxcbiAgICAgICAgY29uZmlnLFxuICAgICAgICBhdXRoLFxuICAgICAgICBpbmZvLFxuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgfSxcbiAgfSk7XG5cbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgIHJlc2V0UGFzc3dvcmRNdXRhdGlvbi5hcmdzLmlucHV0LnR5cGUub2ZUeXBlLFxuICAgIHRydWUsXG4gICAgdHJ1ZVxuICApO1xuICBwYXJzZUdyYXBoUUxTY2hlbWEuYWRkR3JhcGhRTFR5cGUocmVzZXRQYXNzd29yZE11dGF0aW9uLnR5cGUsIHRydWUsIHRydWUpO1xuICBwYXJzZUdyYXBoUUxTY2hlbWEuYWRkR3JhcGhRTE11dGF0aW9uKFxuICAgICdyZXNldFBhc3N3b3JkJyxcbiAgICByZXNldFBhc3N3b3JkTXV0YXRpb24sXG4gICAgdHJ1ZSxcbiAgICB0cnVlXG4gICk7XG5cbiAgY29uc3Qgc2VuZFZlcmlmaWNhdGlvbkVtYWlsTXV0YXRpb24gPSBtdXRhdGlvbldpdGhDbGllbnRNdXRhdGlvbklkKHtcbiAgICBuYW1lOiAnU2VuZFZlcmlmaWNhdGlvbkVtYWlsJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdUaGUgc2VuZFZlcmlmaWNhdGlvbkVtYWlsIG11dGF0aW9uIGNhbiBiZSB1c2VkIHRvIHNlbmQgdGhlIHZlcmlmaWNhdGlvbiBlbWFpbCBhZ2Fpbi4nLFxuICAgIGlucHV0RmllbGRzOiB7XG4gICAgICBlbWFpbDoge1xuICAgICAgICBkZXNjcmlwdGlvbnM6XG4gICAgICAgICAgJ0VtYWlsIG9mIHRoZSB1c2VyIHRoYXQgc2hvdWxkIHJlY2VpdmUgdGhlIHZlcmlmaWNhdGlvbiBlbWFpbCcsXG4gICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChHcmFwaFFMU3RyaW5nKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgICBvdXRwdXRGaWVsZHM6IHtcbiAgICAgIG9rOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIkl0J3MgYWx3YXlzIHRydWUuXCIsXG4gICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTm9uTnVsbChHcmFwaFFMQm9vbGVhbiksXG4gICAgICB9LFxuICAgIH0sXG4gICAgbXV0YXRlQW5kR2V0UGF5bG9hZDogYXN5bmMgKHsgZW1haWwgfSwgY29udGV4dCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBjb25maWcsIGF1dGgsIGluZm8gfSA9IGNvbnRleHQ7XG5cbiAgICAgICAgYXdhaXQgdXNlcnNSb3V0ZXIuaGFuZGxlVmVyaWZpY2F0aW9uRW1haWxSZXF1ZXN0KHtcbiAgICAgICAgICBib2R5OiB7XG4gICAgICAgICAgICBlbWFpbCxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICBhdXRoLFxuICAgICAgICAgIGluZm8sXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5oYW5kbGVFcnJvcihlKTtcbiAgICAgIH1cbiAgICB9LFxuICB9KTtcblxuICBwYXJzZUdyYXBoUUxTY2hlbWEuYWRkR3JhcGhRTFR5cGUoXG4gICAgc2VuZFZlcmlmaWNhdGlvbkVtYWlsTXV0YXRpb24uYXJncy5pbnB1dC50eXBlLm9mVHlwZSxcbiAgICB0cnVlLFxuICAgIHRydWVcbiAgKTtcbiAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgIHNlbmRWZXJpZmljYXRpb25FbWFpbE11dGF0aW9uLnR5cGUsXG4gICAgdHJ1ZSxcbiAgICB0cnVlXG4gICk7XG4gIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMTXV0YXRpb24oXG4gICAgJ3NlbmRWZXJpZmljYXRpb25FbWFpbCcsXG4gICAgc2VuZFZlcmlmaWNhdGlvbkVtYWlsTXV0YXRpb24sXG4gICAgdHJ1ZSxcbiAgICB0cnVlXG4gICk7XG59O1xuXG5leHBvcnQgeyBsb2FkIH07XG4iXX0=