"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.GridStoreAdapter = void 0;

var _mongodb = require("mongodb");

var _FilesAdapter = require("./FilesAdapter");

var _defaults = _interopRequireDefault(require("../../defaults"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/**
 GridStoreAdapter
 Stores files in Mongo using GridStore
 Requires the database adapter to be based on mongoclient
 (GridStore is deprecated, Please use GridFSBucket instead)

 
 */
// -disable-next
class GridStoreAdapter extends _FilesAdapter.FilesAdapter {
  constructor(mongoDatabaseURI = _defaults.default.DefaultMongoURI, mongoOptions = {}) {
    super();
    this._databaseURI = mongoDatabaseURI;
    const defaultMongoOptions = {
      useNewUrlParser: true,
      useUnifiedTopology: true
    };
    this._mongoOptions = Object.assign(defaultMongoOptions, mongoOptions);
  }

  _connect() {
    if (!this._connectionPromise) {
      this._connectionPromise = _mongodb.MongoClient.connect(this._databaseURI, this._mongoOptions).then(client => {
        this._client = client;
        return client.db(client.s.options.dbName);
      });
    }

    return this._connectionPromise;
  } // For a given config object, filename, and data, store a file
  // Returns a promise


  createFile(filename, data) {
    return this._connect().then(database => {
      const gridStore = new _mongodb.GridStore(database, filename, 'w');
      return gridStore.open();
    }).then(gridStore => {
      return gridStore.write(data);
    }).then(gridStore => {
      return gridStore.close();
    });
  }

  deleteFile(filename) {
    return this._connect().then(database => {
      const gridStore = new _mongodb.GridStore(database, filename, 'r');
      return gridStore.open();
    }).then(gridStore => {
      return gridStore.unlink();
    }).then(gridStore => {
      return gridStore.close();
    });
  }

  getFileData(filename) {
    return this._connect().then(database => {
      return _mongodb.GridStore.exist(database, filename).then(() => {
        const gridStore = new _mongodb.GridStore(database, filename, 'r');
        return gridStore.open();
      });
    }).then(gridStore => {
      return gridStore.read();
    });
  }

  getFileLocation(config, filename) {
    return config.mount + '/files/' + config.applicationId + '/' + encodeURIComponent(filename);
  }

  async handleFileStream(filename, req, res, contentType) {
    const stream = await this._connect().then(database => {
      return _mongodb.GridStore.exist(database, filename).then(() => {
        const gridStore = new _mongodb.GridStore(database, filename, 'r');
        return gridStore.open();
      });
    });
    handleRangeRequest(stream, req, res, contentType);
  }

  handleShutdown() {
    if (!this._client) {
      return Promise.resolve();
    }

    return this._client.close(false);
  }

  validateFilename(filename) {
    return (0, _FilesAdapter.validateFilename)(filename);
  }

} // handleRangeRequest is licensed under Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/).
// Author: LEROIB at weightingformypizza (https://weightingformypizza.wordpress.com/2015/06/24/stream-html5-media-content-like-video-audio-from-mongodb-using-express-and-gridstore/).


exports.GridStoreAdapter = GridStoreAdapter;

function handleRangeRequest(stream, req, res, contentType) {
  const buffer_size = 1024 * 1024; //1024Kb
  // Range request, partial stream the file

  const parts = req.get('Range').replace(/bytes=/, '').split('-');
  let [start, end] = parts;
  const notEnded = !end && end !== 0;
  const notStarted = !start && start !== 0; // No end provided, we want all bytes

  if (notEnded) {
    end = stream.length - 1;
  } // No start provided, we're reading backwards


  if (notStarted) {
    start = stream.length - end;
    end = start + end - 1;
  } // Data exceeds the buffer_size, cap


  if (end - start >= buffer_size) {
    end = start + buffer_size - 1;
  }

  const contentLength = end - start + 1;
  res.writeHead(206, {
    'Content-Range': 'bytes ' + start + '-' + end + '/' + stream.length,
    'Accept-Ranges': 'bytes',
    'Content-Length': contentLength,
    'Content-Type': contentType
  });
  stream.seek(start, function () {
    // Get gridFile stream
    const gridFileStream = stream.stream(true);
    let bufferAvail = 0;
    let remainingBytesToWrite = contentLength;
    let totalBytesWritten = 0; // Write to response

    gridFileStream.on('data', function (data) {
      bufferAvail += data.length;

      if (bufferAvail > 0) {
        // slice returns the same buffer if overflowing
        // safe to call in any case
        const buffer = data.slice(0, remainingBytesToWrite); // Write the buffer

        res.write(buffer); // Increment total

        totalBytesWritten += buffer.length; // Decrement remaining

        remainingBytesToWrite -= data.length; // Decrement the available buffer

        bufferAvail -= buffer.length;
      } // In case of small slices, all values will be good at that point
      // we've written enough, end...


      if (totalBytesWritten >= contentLength) {
        stream.close();
        res.end();
        this.destroy();
      }
    });
  });
}

var _default = GridStoreAdapter;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9GaWxlcy9HcmlkU3RvcmVBZGFwdGVyLmpzIl0sIm5hbWVzIjpbIkdyaWRTdG9yZUFkYXB0ZXIiLCJGaWxlc0FkYXB0ZXIiLCJjb25zdHJ1Y3RvciIsIm1vbmdvRGF0YWJhc2VVUkkiLCJkZWZhdWx0cyIsIkRlZmF1bHRNb25nb1VSSSIsIm1vbmdvT3B0aW9ucyIsIl9kYXRhYmFzZVVSSSIsImRlZmF1bHRNb25nb09wdGlvbnMiLCJ1c2VOZXdVcmxQYXJzZXIiLCJ1c2VVbmlmaWVkVG9wb2xvZ3kiLCJfbW9uZ29PcHRpb25zIiwiT2JqZWN0IiwiYXNzaWduIiwiX2Nvbm5lY3QiLCJfY29ubmVjdGlvblByb21pc2UiLCJNb25nb0NsaWVudCIsImNvbm5lY3QiLCJ0aGVuIiwiY2xpZW50IiwiX2NsaWVudCIsImRiIiwicyIsIm9wdGlvbnMiLCJkYk5hbWUiLCJjcmVhdGVGaWxlIiwiZmlsZW5hbWUiLCJkYXRhIiwiZGF0YWJhc2UiLCJncmlkU3RvcmUiLCJHcmlkU3RvcmUiLCJvcGVuIiwid3JpdGUiLCJjbG9zZSIsImRlbGV0ZUZpbGUiLCJ1bmxpbmsiLCJnZXRGaWxlRGF0YSIsImV4aXN0IiwicmVhZCIsImdldEZpbGVMb2NhdGlvbiIsImNvbmZpZyIsIm1vdW50IiwiYXBwbGljYXRpb25JZCIsImVuY29kZVVSSUNvbXBvbmVudCIsImhhbmRsZUZpbGVTdHJlYW0iLCJyZXEiLCJyZXMiLCJjb250ZW50VHlwZSIsInN0cmVhbSIsImhhbmRsZVJhbmdlUmVxdWVzdCIsImhhbmRsZVNodXRkb3duIiwiUHJvbWlzZSIsInJlc29sdmUiLCJ2YWxpZGF0ZUZpbGVuYW1lIiwiYnVmZmVyX3NpemUiLCJwYXJ0cyIsImdldCIsInJlcGxhY2UiLCJzcGxpdCIsInN0YXJ0IiwiZW5kIiwibm90RW5kZWQiLCJub3RTdGFydGVkIiwibGVuZ3RoIiwiY29udGVudExlbmd0aCIsIndyaXRlSGVhZCIsInNlZWsiLCJncmlkRmlsZVN0cmVhbSIsImJ1ZmZlckF2YWlsIiwicmVtYWluaW5nQnl0ZXNUb1dyaXRlIiwidG90YWxCeXRlc1dyaXR0ZW4iLCJvbiIsImJ1ZmZlciIsInNsaWNlIiwiZGVzdHJveSJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQVVBOztBQUNBOztBQUNBOzs7O0FBWkE7Ozs7Ozs7O0FBU0E7QUFLTyxNQUFNQSxnQkFBTixTQUErQkMsMEJBQS9CLENBQTRDO0FBS2pEQyxFQUFBQSxXQUFXLENBQUNDLGdCQUFnQixHQUFHQyxrQkFBU0MsZUFBN0IsRUFBOENDLFlBQVksR0FBRyxFQUE3RCxFQUFpRTtBQUMxRTtBQUNBLFNBQUtDLFlBQUwsR0FBb0JKLGdCQUFwQjtBQUVBLFVBQU1LLG1CQUFtQixHQUFHO0FBQzFCQyxNQUFBQSxlQUFlLEVBQUUsSUFEUztBQUUxQkMsTUFBQUEsa0JBQWtCLEVBQUU7QUFGTSxLQUE1QjtBQUlBLFNBQUtDLGFBQUwsR0FBcUJDLE1BQU0sQ0FBQ0MsTUFBUCxDQUFjTCxtQkFBZCxFQUFtQ0YsWUFBbkMsQ0FBckI7QUFDRDs7QUFFRFEsRUFBQUEsUUFBUSxHQUFHO0FBQ1QsUUFBSSxDQUFDLEtBQUtDLGtCQUFWLEVBQThCO0FBQzVCLFdBQUtBLGtCQUFMLEdBQTBCQyxxQkFBWUMsT0FBWixDQUFvQixLQUFLVixZQUF6QixFQUF1QyxLQUFLSSxhQUE1QyxFQUEyRE8sSUFBM0QsQ0FDeEJDLE1BQU0sSUFBSTtBQUNSLGFBQUtDLE9BQUwsR0FBZUQsTUFBZjtBQUNBLGVBQU9BLE1BQU0sQ0FBQ0UsRUFBUCxDQUFVRixNQUFNLENBQUNHLENBQVAsQ0FBU0MsT0FBVCxDQUFpQkMsTUFBM0IsQ0FBUDtBQUNELE9BSnVCLENBQTFCO0FBTUQ7O0FBQ0QsV0FBTyxLQUFLVCxrQkFBWjtBQUNELEdBMUJnRCxDQTRCakQ7QUFDQTs7O0FBQ0FVLEVBQUFBLFVBQVUsQ0FBQ0MsUUFBRCxFQUFtQkMsSUFBbkIsRUFBeUI7QUFDakMsV0FBTyxLQUFLYixRQUFMLEdBQ0pJLElBREksQ0FDQ1UsUUFBUSxJQUFJO0FBQ2hC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QUFLYyxPQUFMO0FBQ0Q7QUFDRixLQXRCRDtBQXVCRCxHQTlCRDtBQStCRDs7ZUFFYzFFLGdCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gR3JpZFN0b3JlQWRhcHRlclxuIFN0b3JlcyBmaWxlcyBpbiBNb25nbyB1c2luZyBHcmlkU3RvcmVcbiBSZXF1aXJlcyB0aGUgZGF0YWJhc2UgYWRhcHRlciB0byBiZSBiYXNlZCBvbiBtb25nb2NsaWVudFxuIChHcmlkU3RvcmUgaXMgZGVwcmVjYXRlZCwgUGxlYXNlIHVzZSBHcmlkRlNCdWNrZXQgaW5zdGVhZClcblxuIEBmbG93IHdlYWtcbiAqL1xuXG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCB7IE1vbmdvQ2xpZW50LCBHcmlkU3RvcmUsIERiIH0gZnJvbSAnbW9uZ29kYic7XG5pbXBvcnQgeyBGaWxlc0FkYXB0ZXIsIHZhbGlkYXRlRmlsZW5hbWUgfSBmcm9tICcuL0ZpbGVzQWRhcHRlcic7XG5pbXBvcnQgZGVmYXVsdHMgZnJvbSAnLi4vLi4vZGVmYXVsdHMnO1xuXG5leHBvcnQgY2xhc3MgR3JpZFN0b3JlQWRhcHRlciBleHRlbmRzIEZpbGVzQWRhcHRlciB7XG4gIF9kYXRhYmFzZVVSSTogc3RyaW5nO1xuICBfY29ubmVjdGlvblByb21pc2U6IFByb21pc2U8RGI+O1xuICBfbW9uZ29PcHRpb25zOiBPYmplY3Q7XG5cbiAgY29uc3RydWN0b3IobW9uZ29EYXRhYmFzZVVSSSA9IGRlZmF1bHRzLkRlZmF1bHRNb25nb1VSSSwgbW9uZ29PcHRpb25zID0ge30pIHtcbiAgICBzdXBlcigpO1xuICAgIHRoaXMuX2RhdGFiYXNlVVJJID0gbW9uZ29EYXRhYmFzZVVSSTtcblxuICAgIGNvbnN0IGRlZmF1bHRNb25nb09wdGlvbnMgPSB7XG4gICAgICB1c2VOZXdVcmxQYXJzZXI6IHRydWUsXG4gICAgICB1c2VVbmlmaWVkVG9wb2xvZ3k6IHRydWUsXG4gICAgfTtcbiAgICB0aGlzLl9tb25nb09wdGlvbnMgPSBPYmplY3QuYXNzaWduKGRlZmF1bHRNb25nb09wdGlvbnMsIG1vbmdvT3B0aW9ucyk7XG4gIH1cblxuICBfY29ubmVjdCgpIHtcbiAgICBpZiAoIXRoaXMuX2Nvbm5lY3Rpb25Qcm9taXNlKSB7XG4gICAgICB0aGlzLl9jb25uZWN0aW9uUHJvbWlzZSA9IE1vbmdvQ2xpZW50LmNvbm5lY3QodGhpcy5fZGF0YWJhc2VVUkksIHRoaXMuX21vbmdvT3B0aW9ucykudGhlbihcbiAgICAgICAgY2xpZW50ID0+IHtcbiAgICAgICAgICB0aGlzLl9jbGllbnQgPSBjbGllbnQ7XG4gICAgICAgICAgcmV0dXJuIGNsaWVudC5kYihjbGllbnQucy5vcHRpb25zLmRiTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9jb25uZWN0aW9uUHJvbWlzZTtcbiAgfVxuXG4gIC8vIEZvciBhIGdpdmVuIGNvbmZpZyBvYmplY3QsIGZpbGVuYW1lLCBhbmQgZGF0YSwgc3RvcmUgYSBmaWxlXG4gIC8vIFJldHVybnMgYSBwcm9taXNlXG4gIGNyZWF0ZUZpbGUoZmlsZW5hbWU6IHN0cmluZywgZGF0YSkge1xuICAgIHJldHVybiB0aGlzLl9jb25uZWN0KClcbiAgICAgIC50aGVuKGRhdGFiYXNlID0+IHtcbiAgICAgICAgY29uc3QgZ3JpZFN0b3JlID0gbmV3IEdyaWRTdG9yZShkYXRhYmFzZSwgZmlsZW5hbWUsICd3Jyk7XG4gICAgICAgIHJldHVybiBncmlkU3RvcmUub3BlbigpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKGdyaWRTdG9yZSA9PiB7XG4gICAgICAgIHJldHVybiBncmlkU3RvcmUud3JpdGUoZGF0YSk7XG4gICAgICB9KVxuICAgICAgLnRoZW4oZ3JpZFN0b3JlID0+IHtcbiAgICAgICAgcmV0dXJuIGdyaWRTdG9yZS5jbG9zZSgpO1xuICAgICAgfSk7XG4gIH1cblxuICBkZWxldGVGaWxlKGZpbGVuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fY29ubmVjdCgpXG4gICAgICAudGhlbihkYXRhYmFzZSA9PiB7XG4gICAgICAgIGNvbnN0IGdyaWRTdG9yZSA9IG5ldyBHcmlkU3RvcmUoZGF0YWJhc2UsIGZpbGVuYW1lLCAncicpO1xuICAgICAgICByZXR1cm4gZ3JpZFN0b3JlLm9wZW4oKTtcbiAgICAgIH0pXG4gICAgICAudGhlbihncmlkU3RvcmUgPT4ge1xuICAgICAgICByZXR1cm4gZ3JpZFN0b3JlLnVubGluaygpO1xuICAgICAgfSlcbiAgICAgIC50aGVuKGdyaWRTdG9yZSA9PiB7XG4gICAgICAgIHJldHVybiBncmlkU3RvcmUuY2xvc2UoKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgZ2V0RmlsZURhdGEoZmlsZW5hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9jb25uZWN0KClcbiAgICAgIC50aGVuKGRhdGFiYXNlID0+IHtcbiAgICAgICAgcmV0dXJuIEdyaWRTdG9yZS5leGlzdChkYXRhYmFzZSwgZmlsZW5hbWUpLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGdyaWRTdG9yZSA9IG5ldyBHcmlkU3RvcmUoZGF0YWJhc2UsIGZpbGVuYW1lLCAncicpO1xuICAgICAgICAgIHJldHVybiBncmlkU3RvcmUub3BlbigpO1xuICAgICAgICB9KTtcbiAgICAgIH0pXG4gICAgICAudGhlbihncmlkU3RvcmUgPT4ge1xuICAgICAgICByZXR1cm4gZ3JpZFN0b3JlLnJlYWQoKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgZ2V0RmlsZUxvY2F0aW9uKGNvbmZpZywgZmlsZW5hbWUpIHtcbiAgICByZXR1cm4gY29uZmlnLm1vdW50ICsgJy9maWxlcy8nICsgY29uZmlnLmFwcGxpY2F0aW9uSWQgKyAnLycgKyBlbmNvZGVVUklDb21wb25lbnQoZmlsZW5hbWUpO1xuICB9XG5cbiAgYXN5bmMgaGFuZGxlRmlsZVN0cmVhbShmaWxlbmFtZTogc3RyaW5nLCByZXEsIHJlcywgY29udGVudFR5cGUpIHtcbiAgICBjb25zdCBzdHJlYW0gPSBhd2FpdCB0aGlzLl9jb25uZWN0KCkudGhlbihkYXRhYmFzZSA9PiB7XG4gICAgICByZXR1cm4gR3JpZFN0b3JlLmV4aXN0KGRhdGFiYXNlLCBmaWxlbmFtZSkudGhlbigoKSA9PiB7XG4gICAgICAgIGNvbnN0IGdyaWRTdG9yZSA9IG5ldyBHcmlkU3RvcmUoZGF0YWJhc2UsIGZpbGVuYW1lLCAncicpO1xuICAgICAgICByZXR1cm4gZ3JpZFN0b3JlLm9wZW4oKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICAgIGhhbmRsZVJhbmdlUmVxdWVzdChzdHJlYW0sIHJlcSwgcmVzLCBjb250ZW50VHlwZSk7XG4gIH1cblxuICBoYW5kbGVTaHV0ZG93bigpIHtcbiAgICBpZiAoIXRoaXMuX2NsaWVudCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5fY2xpZW50LmNsb3NlKGZhbHNlKTtcbiAgfVxuXG4gIHZhbGlkYXRlRmlsZW5hbWUoZmlsZW5hbWUpIHtcbiAgICByZXR1cm4gdmFsaWRhdGVGaWxlbmFtZShmaWxlbmFtZSk7XG4gIH1cbn1cblxuLy8gaGFuZGxlUmFuZ2VSZXF1ZXN0IGlzIGxpY2Vuc2VkIHVuZGVyIENyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24gNC4wIEludGVybmF0aW9uYWwgTGljZW5zZSAoaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL2xpY2Vuc2VzL2J5LzQuMC8pLlxuLy8gQXV0aG9yOiBMRVJPSUIgYXQgd2VpZ2h0aW5nZm9ybXlwaXp6YSAoaHR0cHM6Ly93ZWlnaHRpbmdmb3JteXBpenphLndvcmRwcmVzcy5jb20vMjAxNS8wNi8yNC9zdHJlYW0taHRtbDUtbWVkaWEtY29udGVudC1saWtlLXZpZGVvLWF1ZGlvLWZyb20tbW9uZ29kYi11c2luZy1leHByZXNzLWFuZC1ncmlkc3RvcmUvKS5cbmZ1bmN0aW9uIGhhbmRsZVJhbmdlUmVxdWVzdChzdHJlYW0sIHJlcSwgcmVzLCBjb250ZW50VHlwZSkge1xuICBjb25zdCBidWZmZXJfc2l6ZSA9IDEwMjQgKiAxMDI0OyAvLzEwMjRLYlxuICAvLyBSYW5nZSByZXF1ZXN0LCBwYXJ0aWFsIHN0cmVhbSB0aGUgZmlsZVxuICBjb25zdCBwYXJ0cyA9IHJlcVxuICAgIC5nZXQoJ1JhbmdlJylcbiAgICAucmVwbGFjZSgvYnl0ZXM9LywgJycpXG4gICAgLnNwbGl0KCctJyk7XG4gIGxldCBbc3RhcnQsIGVuZF0gPSBwYXJ0cztcbiAgY29uc3Qgbm90RW5kZWQgPSAhZW5kICYmIGVuZCAhPT0gMDtcbiAgY29uc3Qgbm90U3RhcnRlZCA9ICFzdGFydCAmJiBzdGFydCAhPT0gMDtcbiAgLy8gTm8gZW5kIHByb3ZpZGVkLCB3ZSB3YW50IGFsbCBieXRlc1xuICBpZiAobm90RW5kZWQpIHtcbiAgICBlbmQgPSBzdHJlYW0ubGVuZ3RoIC0gMTtcbiAgfVxuICAvLyBObyBzdGFydCBwcm92aWRlZCwgd2UncmUgcmVhZGluZyBiYWNrd2FyZHNcbiAgaWYgKG5vdFN0YXJ0ZWQpIHtcbiAgICBzdGFydCA9IHN0cmVhbS5sZW5ndGggLSBlbmQ7XG4gICAgZW5kID0gc3RhcnQgKyBlbmQgLSAxO1xuICB9XG5cbiAgLy8gRGF0YSBleGNlZWRzIHRoZSBidWZmZXJfc2l6ZSwgY2FwXG4gIGlmIChlbmQgLSBzdGFydCA+PSBidWZmZXJfc2l6ZSkge1xuICAgIGVuZCA9IHN0YXJ0ICsgYnVmZmVyX3NpemUgLSAxO1xuICB9XG5cbiAgY29uc3QgY29udGVudExlbmd0aCA9IGVuZCAtIHN0YXJ0ICsgMTtcblxuICByZXMud3JpdGVIZWFkKDIwNiwge1xuICAgICdDb250ZW50LVJhbmdlJzogJ2J5dGVzICcgKyBzdGFydCArICctJyArIGVuZCArICcvJyArIHN0cmVhbS5sZW5ndGgsXG4gICAgJ0FjY2VwdC1SYW5nZXMnOiAnYnl0ZXMnLFxuICAgICdDb250ZW50LUxlbmd0aCc6IGNvbnRlbnRMZW5ndGgsXG4gICAgJ0NvbnRlbnQtVHlwZSc6IGNvbnRlbnRUeXBlLFxuICB9KTtcblxuICBzdHJlYW0uc2VlayhzdGFydCwgZnVuY3Rpb24gKCkge1xuICAgIC8vIEdldCBncmlkRmlsZSBzdHJlYW1cbiAgICBjb25zdCBncmlkRmlsZVN0cmVhbSA9IHN0cmVhbS5zdHJlYW0odHJ1ZSk7XG4gICAgbGV0IGJ1ZmZlckF2YWlsID0gMDtcbiAgICBsZXQgcmVtYWluaW5nQnl0ZXNUb1dyaXRlID0gY29udGVudExlbmd0aDtcbiAgICBsZXQgdG90YWxCeXRlc1dyaXR0ZW4gPSAwO1xuICAgIC8vIFdyaXRlIHRvIHJlc3BvbnNlXG4gICAgZ3JpZEZpbGVTdHJlYW0ub24oJ2RhdGEnLCBmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgYnVmZmVyQXZhaWwgKz0gZGF0YS5sZW5ndGg7XG4gICAgICBpZiAoYnVmZmVyQXZhaWwgPiAwKSB7XG4gICAgICAgIC8vIHNsaWNlIHJldHVybnMgdGhlIHNhbWUgYnVmZmVyIGlmIG92ZXJmbG93aW5nXG4gICAgICAgIC8vIHNhZmUgdG8gY2FsbCBpbiBhbnkgY2FzZVxuICAgICAgICBjb25zdCBidWZmZXIgPSBkYXRhLnNsaWNlKDAsIHJlbWFpbmluZ0J5dGVzVG9Xcml0ZSk7XG4gICAgICAgIC8vIFdyaXRlIHRoZSBidWZmZXJcbiAgICAgICAgcmVzLndyaXRlKGJ1ZmZlcik7XG4gICAgICAgIC8vIEluY3JlbWVudCB0b3RhbFxuICAgICAgICB0b3RhbEJ5dGVzV3JpdHRlbiArPSBidWZmZXIubGVuZ3RoO1xuICAgICAgICAvLyBEZWNyZW1lbnQgcmVtYWluaW5nXG4gICAgICAgIHJlbWFpbmluZ0J5dGVzVG9Xcml0ZSAtPSBkYXRhLmxlbmd0aDtcbiAgICAgICAgLy8gRGVjcmVtZW50IHRoZSBhdmFpbGFibGUgYnVmZmVyXG4gICAgICAgIGJ1ZmZlckF2YWlsIC09IGJ1ZmZlci5sZW5ndGg7XG4gICAgICB9XG4gICAgICAvLyBJbiBjYXNlIG9mIHNtYWxsIHNsaWNlcywgYWxsIHZhbHVlcyB3aWxsIGJlIGdvb2QgYXQgdGhhdCBwb2ludFxuICAgICAgLy8gd2UndmUgd3JpdHRlbiBlbm91Z2gsIGVuZC4uLlxuICAgICAgaWYgKHRvdGFsQnl0ZXNXcml0dGVuID49IGNvbnRlbnRMZW5ndGgpIHtcbiAgICAgICAgc3RyZWFtLmNsb3NlKCk7XG4gICAgICAgIHJlcy5lbmQoKTtcbiAgICAgICAgdGhpcy5kZXN0cm95KCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuXG5leHBvcnQgZGVmYXVsdCBHcmlkU3RvcmVBZGFwdGVyO1xuIl19