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
    const { token, username, mail } = req.query;
    const appId = process.env.APP_ID || 'TicketFuchs';
    console.log(`AppID: ${appId}`);
    const config = Config.get(appId);

    if (!config) {
      console.log("PublicApiRouter.js L. 18");
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    if (!token || !username|| !mail) {
      console.log(`Mailadresse: ${mail}`);
      console.log("PublicApiRouter.js L. 28");
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
    const appId = process.env.APP_ID || 'TicketFuchs';
    console.log(`AppID: ${appId}`);


    const config = Config.get(appId);

    if (!config) {
      console.log("PublicApiRouter.js L. 51");
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    if (!username) {
      console.log("PublicApiRouter.js L. 68");
      return this.invalidLink(req);
    }

    const userController = config.userController;

    return userController.resendVerificationEmail(username).then(
      () => {
        return Promise.resolve({
          status: 302,
          location: `${config.linkSendSuccessURL}`,
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

  changePassword(req) {

    return new Promise((resolve, reject) => {
      const appId = process.env.APP_ID || 'TicketFuchs';
      const config = Config.get(appId);

      if (!config) {
        console.log("PublicApiRouter.js L. 95");
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
    const appId = process.env.APP_ID || 'TicketFuchs';
    console.log(`AppID: ${appId}`);
    const config = Config.get(appId);


    if (!config) {
      console.log("PublicApiRouter.js L. 120");
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    const { username, token, mail } = req.query;

    if (!username || !token || !mail) {
      console.log(`Mailadresse: ${mail}`);
      console.log("PublicApiRouter.js L. 28");
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
    const appId = process.env.APP_ID || 'TicketFuchs';
    console.log(`AppID: ${appId}`);
    const config = Config.get(appId);

    if (!config) {
      console.log("PublicApiRouter.js L. 157");
      this.invalidRequest();
    }

    if (!config.publicServerURL) {
      return this.missingPublicServerURL();
    }

    const { username, token, new_password, mail } = req.body;

    if ((!username || !token || !new_password || !mail) && req.xhr === false) {
      console.log("PublicApiRouter.js L. 185");
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

        return Promise.resolve({
          status: 302,
          location: `${
            result.success
              ? `${config.passwordResetSuccessURL}?mail=${mail}`
              : `${config.choosePasswordURL}?${params}`
          }`,
        });
      });
  }

  invalidLink(req) {
    var config = null;
    if(req === undefined) {
    const appId = process.env.APP_ID || 'TicketFuchs';
    config = Config.get(appId);
    }
    else {
      config = req.config;
    }
    return Promise.resolve({
      status: 302,
      location: config.invalidLinkURL,
    });
  }

  invalidVerificationLink(req) {
    var config = req.config;
    if(config === undefined) {
      const appId = process.env.APP_ID || 'TicketFuchs';
      config = Config.get(appId);
      }

    if (req.query.username) {
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
    const appId = process.env.APP_ID || 'TicketFuchs';
    req.config = Config.get(appId);
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

    this.route('GET', '/choose_password', req => {
      return this.changePassword(req);
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
