import PromiseRouter from '../PromiseRouter';
import Config from '../Config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import qs from 'querystring';
import { Parse } from 'parse/node';

const public_html = path.resolve(__dirname, '../../public_html');
const views = path.resolve(__dirname, '../../views');

export class PublicAPIRouter extends PromiseRouter {
  verifyEmail(req) {
    const { username, token: rawToken, mail } = req.query;
    const token =
      rawToken && typeof rawToken !== 'string' ? rawToken.toString() : rawToken;

    const appId = process.env.APP_ID;
    const config = Config.get(appId);

    if (!config) {
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    if (!token || !username || !mail) {
      console.log(`Mailadresse: ${mail}`);
      return this.invalidLink(req);
    }

    const userController = config.userController;
    return userController.verifyEmail(username, token).then(
      () => {
        const params = qs.stringify({ mail });
        return Promise.resolve({
          status: 302,
          location: `${config.verifyEmailSuccessURL}?${params}`,
        });
      },
      () => {
        return this.invalidVerificationLink(req);
      }
    );
  }

  resendVerificationEmail(req) {
    const username = req.body.username;
    const appId = process.env.APP_ID;
    const config = Config.get(appId);

    if (!config) {
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    if (!username) {
      return this.invalidLink(req);
    }

    const userController = config.userController;

    return userController.resendVerificationEmail(username).then(
      () => {
        const params = qs.stringify({ username });
        return Promise.resolve({
          status: 302,
          location: `${config.linkSendSuccessURL}?${params}`,
        });
      },
      () => {
        return Promise.resolve({
          status: 302,
          location: `${config.linkSendFailURL}`,
        });
      }
    );
  }

  changePassword() {
    return new Promise((resolve, reject) => {
      const config = Config.get(process.env.APP_ID);

      if (!config) {
        this.invalidRequest();
      }

      if (!config.publicServerURL) {
        return resolve({
          status: 404,
          text: 'Not found.',
        });
      }
      // Should we keep the file in memory or leave like that?
      fs.readFile(
        path.resolve(views, 'choose_password'),
        'utf-8',
        (err, data) => {
          if (err) {
            return reject(err);
          }
          data = data.replace(
            'PARSE_SERVER_URL',
            `'${config.publicServerURL}'`
          );
          resolve({
            text: data,
          });
        }
      );
    });
  }

  requestResetPassword(req) {
    const config = Config.get(process.env.APP_ID);

    if (!config) {
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    const { username, token: rawToken, mail } = req.query;
    const token =
      rawToken && typeof rawToken !== 'string' ? rawToken.toString() : rawToken;

    if (!username || !token || !mail) {
      console.log(`Mailadresse: ${mail}`);
      return this.invalidLink(req);
    }

    return config.userController.checkResetTokenValidity(username, token).then(
      () => {
        const params = qs.stringify({
          token,
          mail: mail,
          id: config.applicationId,
          username,
          app: config.appName,
        });
        return Promise.resolve({
          status: 302,
          location: `${config.choosePasswordURL}?${params}`,
        });
      },
      () => {
        return this.invalidLink(req);
      }
    );
  }

  resetPassword(req) {
    const config = Config.get(process.env.APP_ID);

    if (!config) {
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    const { username, new_password, token: rawToken, mail } = req.body;
    const token =
      rawToken && typeof rawToken !== 'string' ? rawToken.toString() : rawToken;

    if ((!username || !token || !new_password || !mail) && req.xhr === false) {
      console.log('PublicApiRouter.js L. 185');
      return this.invalidLink(req);
    }

    if (!username) {
      throw new Parse.Error(Parse.Error.USERNAME_MISSING, 'Missing username');
    }

    if (!token) {
      throw new Parse.Error(Parse.Error.OTHER_CAUSE, 'Missing token');
    }

    if (!new_password) {
      throw new Parse.Error(Parse.Error.PASSWORD_MISSING, 'Missing password');
    }

    if (!mail) {
      throw new Parse.Error(Parse.Error.EMAIL_MISSING, 'Missing Mail');
    }

    return config.userController
      .updatePassword(username, token, new_password)
      .then(
        () => {
          return Promise.resolve({
            success: true,
          });
        },
        err => {
          return Promise.resolve({
            success: false,
            err,
          });
        }
      )
      .then(result => {
        const params = qs.stringify({
          username: username,
          token: token,
          id: config.applicationId,
          error: result.err,
          app: config.appName,
          mail: mail,
        });

        if (req.xhr) {
          if (result.success) {
            return Promise.resolve({
              status: 200,
              response: 'Password successfully reset',
            });
          }
          if (result.err) {
            throw new Parse.Error(Parse.Error.OTHER_CAUSE, `${result.err}`);
          }
        }

        const encodedUsername = encodeURIComponent(mail);
        const location = result.success
          ? `${config.passwordResetSuccessURL}?mail=${encodedUsername}`
          : `${config.choosePasswordURL}?${params}`;

        return Promise.resolve({
          status: 302,
          location,
        });
      });
  }

  invalidLink(req) {
    return Promise.resolve({
      status: 302,
      location: req.config.invalidLinkURL,
    });
  }

  invalidVerificationLink(req) {
    const config = req.config;
    if (req.query.username && req.params.appId) {
      const params = qs.stringify({
        username: req.query.username,
      });
      return Promise.resolve({
        status: 302,
        location: `${config.invalidVerificationLinkURL}?${params}`,
      });
    } else {
      return this.invalidLink(req);
    }
  }

  missingPublicServerURL() {
    return Promise.resolve({
      text: 'Not found.',
      status: 404,
    });
  }

  invalidRequest() {
    const error = new Error();
    error.status = 403;
    error.message = 'unauthorized';
    throw error;
  }

  setConfig(req) {
    req.config = Config.get(process.env.APP_ID);
    return Promise.resolve();
  }

  mountRoutes() {
    this.route(
      'GET',
      '/verify_email',
      req => {
        this.setConfig(req);
      },
      req => {
        return this.verifyEmail(req);
      }
    );

    this.route(
      'POST',
      '/resend_verification_email',
      req => {
        this.setConfig(req);
      },
      req => {
        return this.resendVerificationEmail(req);
      }
    );

    this.route('GET', '/choose_password', () => {
      return this.changePassword();
    });

    this.route(
      'POST',
      '/request_password_reset',
      req => {
        this.setConfig(req);
      },
      req => {
        return this.resetPassword(req);
      }
    );

    this.route(
      'GET',
      '/request_password_reset',
      req => {
        this.setConfig(req);
      },
      req => {
        return this.requestResetPassword(req);
      }
    );
  }

  expressRouter() {
    const router = express.Router();
    router.use('/apps', express.static(public_html));
    router.use('/', super.expressRouter());
    return router;
  }
}

export default PublicAPIRouter;
