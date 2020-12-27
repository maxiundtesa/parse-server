"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

const mongodb = require('mongodb');

const Collection = mongodb.Collection;

class MongoCollection {
  constructor(mongoCollection) {
    this._mongoCollection = mongoCollection;
  } // Does a find with "smart indexing".
  // Currently this just means, if it needs a geoindex and there is
  // none, then build the geoindex.
  // This could be improved a lot but it's not clear if that's a good
  // idea. Or even if this behavior is a good idea.


  find(query, {
    skip,
    limit,
    sort,
    keys,
    maxTimeMS,
    readPreference,
    hint,
    caseInsensitive,
    explain
  } = {}) {
    // Support for Full Text Search - $text
    if (keys && keys.$score) {
      delete keys.$score;
      keys.score = {
        $meta: 'textScore'
      };
    }

    return this._rawFind(query, {
      skip,
      limit,
      sort,
      keys,
      maxTimeMS,
      readPreference,
      hint,
      caseInsensitive,
      explain
    }).catch(error => {
      // Check for "no geoindex" error
      if (error.code != 17007 && !error.message.match(/unable to find index for .geoNear/)) {
        throw error;
      } // Figure out what key needs an index


      const key = error.message.match(/field=([A-Za-z_0-9]+) /)[1];

      if (!key) {
        throw error;
      }

      var index = {};
      index[key] = '2d';
      return this._mongoCollection.createIndex(index) // Retry, but just once.
      .then(() => this._rawFind(query, {
        skip,
        limit,
        sort,
        keys,
        maxTimeMS,
        readPreference,
        hint,
        caseInsensitive,
        explain
      }));
    });
  }
  /**
   * Collation to support case insensitive queries
   */


  static caseInsensitiveCollation() {
    return {
      locale: 'en_US',
      strength: 2
    };
  }

  _rawFind(query, {
    skip,
    limit,
    sort,
    keys,
    maxTimeMS,
    readPreference,
    hint,
    caseInsensitive,
    explain
  } = {}) {
    let findOperation = this._mongoCollection.find(query, {
      skip,
      limit,
      sort,
      readPreference,
      hint
    });

    if (keys) {
      findOperation = findOperation.project(keys);
    }

    if (caseInsensitive) {
      findOperation = findOperation.collation(MongoCollection.caseInsensitiveCollation());
    }

    if (maxTimeMS) {
      findOperation = findOperation.maxTimeMS(maxTimeMS);
    }

    return explain ? findOperation.explain(explain) : findOperation.toArray();
  }

  count(query, {
    skip,
    limit,
    sort,
    maxTimeMS,
    readPreference,
    hint
  } = {}) {
    // If query is empty, then use estimatedDocumentCount instead.
    // This is due to countDocuments performing a scan,
    // which greatly increases execution time when being run on large collections.
    // See https://github.com/Automattic/mongoose/issues/6713 for more info regarding this problem.
    if (typeof query !== 'object' || !Object.keys(query).length) {
      return this._mongoCollection.estimatedDocumentCount({
        maxTimeMS
      });
    }

    const countOperation = this._mongoCollection.countDocuments(query, {
      skip,
      limit,
      sort,
      maxTimeMS,
      readPreference,
      hint
    });

    return countOperation;
  }

  distinct(field, query) {
    return this._mongoCollection.distinct(field, query);
  }

  aggregate(pipeline, {
    maxTimeMS,
    readPreference,
    hint,
    explain
  } = {}) {
    return this._mongoCollection.aggregate(pipeline, {
      maxTimeMS,
      readPreference,
      hint,
      explain
    }).toArray();
  }

  insertOne(object, session) {
    return this._mongoCollection.insertOne(object, {
      session
    });
  } // Atomically updates data in the database for a single (first) object that matched the query
  // If there is nothing that matches the query - does insert
  // Postgres Note: `INSERT ... ON CONFLICT UPDATE` that is available since 9.5.


  upsertOne(query, update, session) {
    return this._mongoCollection.updateOne(query, update, {
      upsert: true,
      session
    });
  }

  updateOne(query, update) {
    return this._mongoCollection.updateOne(query, update);
  }

  updateMany(query, update, session) {
    return this._mongoCollection.updateMany(query, update, {
      session
    });
  }

  deleteMany(query, session) {
    return this._mongoCollection.deleteMany(query, {
      session
    });
  }

  _ensureSparseUniqueIndexInBackground(indexRequest) {
    return new Promise((resolve, reject) => {
      this._mongoCollection.createIndex(indexRequest, {
        unique: true,
        background: true,
        sparse: true
      }, error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  drop() {
    return this._mongoCollection.drop();
  }

}

exports.default = MongoCollection;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL01vbmdvL01vbmdvQ29sbGVjdGlvbi5qcyJdLCJuYW1lcyI6WyJtb25nb2RiIiwicmVxdWlyZSIsIkNvbGxlY3Rpb24iLCJNb25nb0NvbGxlY3Rpb24iLCJjb25zdHJ1Y3RvciIsIm1vbmdvQ29sbGVjdGlvbiIsIl9tb25nb0NvbGxlY3Rpb24iLCJmaW5kIiwicXVlcnkiLCJza2lwIiwibGltaXQiLCJzb3J0Iiwia2V5cyIsIm1heFRpbWVNUyIsInJlYWRQcmVmZXJlbmNlIiwiaGludCIsImNhc2VJbnNlbnNpdGl2ZSIsImV4cGxhaW4iLCIkc2NvcmUiLCJzY29yZSIsIiRtZXRhIiwiX3Jhd0ZpbmQiLCJjYXRjaCIsImVycm9yIiwiY29kZSIsIm1lc3NhZ2UiLCJtYXRjaCIsImtleSIsImluZGV4IiwiY3JlYXRlSW5kZXgiLCJ0aGVuIiwiY2FzZUluc2Vuc2l0aXZlQ29sbGF0aW9uIiwibG9jYWxlIiwic3RyZW5ndGgiLCJmaW5kT3BlcmF0aW9uIiwicHJvamVjdCIsImNvbGxhdGlvbiIsInRvQXJyYXkiLCJjb3VudCIsIk9iamVjdCIsImxlbmd0aCIsImVzdGltYXRlZERvY3VtZW50Q291bnQiLCJjb3VudE9wZXJhdGlvbiIsImNvdW50RG9jdW1lbnRzIiwiZGlzdGluY3QiLCJmaWVsZCIsImFnZ3JlZ2F0ZSIsInBpcGVsaW5lIiwiaW5zZXJ0T25lIiwib2JqZWN0Iiwic2Vzc2lvbiIsInVwc2VydE9uZSIsInVwZGF0ZSIsInVwZGF0ZU9uZSIsInVwc2VydCIsInVwZGF0ZU1hbnkiLCJkZWxldGVNYW55IiwiX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kIiwiaW5kZXhSZXF1ZXN0IiwiUHJvbWlzZSIsInJlc29sdmUiLCJyZWplY3QiLCJ1bmlxdWUiLCJiYWNrZ3JvdW5kIiwic3BhcnNlIiwiZHJvcCJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUFBLE1BQU1BLE9BQU8sR0FBR0Ms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Z0JBQUwsQ0FBc0IyRCxJQUF0QixFQUFQO0FBQ0Q7O0FBaExrQyIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IG1vbmdvZGIgPSByZXF1aXJlKCdtb25nb2RiJyk7XG5jb25zdCBDb2xsZWN0aW9uID0gbW9uZ29kYi5Db2xsZWN0aW9uO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBNb25nb0NvbGxlY3Rpb24ge1xuICBfbW9uZ29Db2xsZWN0aW9uOiBDb2xsZWN0aW9uO1xuXG4gIGNvbnN0cnVjdG9yKG1vbmdvQ29sbGVjdGlvbjogQ29sbGVjdGlvbikge1xuICAgIHRoaXMuX21vbmdvQ29sbGVjdGlvbiA9IG1vbmdvQ29sbGVjdGlvbjtcbiAgfVxuXG4gIC8vIERvZXMgYSBmaW5kIHdpdGggXCJzbWFydCBpbmRleGluZ1wiLlxuICAvLyBDdXJyZW50bHkgdGhpcyBqdXN0IG1lYW5zLCBpZiBpdCBuZWVkcyBhIGdlb2luZGV4IGFuZCB0aGVyZSBpc1xuICAvLyBub25lLCB0aGVuIGJ1aWxkIHRoZSBnZW9pbmRleC5cbiAgLy8gVGhpcyBjb3VsZCBiZSBpbXByb3ZlZCBhIGxvdCBidXQgaXQncyBub3QgY2xlYXIgaWYgdGhhdCdzIGEgZ29vZFxuICAvLyBpZGVhLiBPciBldmVuIGlmIHRoaXMgYmVoYXZpb3IgaXMgYSBnb29kIGlkZWEuXG4gIGZpbmQoXG4gICAgcXVlcnksXG4gICAgeyBza2lwLCBsaW1pdCwgc29ydCwga2V5cywgbWF4VGltZU1TLCByZWFkUHJlZmVyZW5jZSwgaGludCwgY2FzZUluc2Vuc2l0aXZlLCBleHBsYWluIH0gPSB7fVxuICApIHtcbiAgICAvLyBTdXBwb3J0IGZvciBGdWxsIFRleHQgU2VhcmNoIC0gJHRleHRcbiAgICBpZiAoa2V5cyAmJiBrZXlzLiRzY29yZSkge1xuICAgICAgZGVsZXRlIGtleXMuJHNjb3JlO1xuICAgICAga2V5cy5zY29yZSA9IHsgJG1ldGE6ICd0ZXh0U2NvcmUnIH07XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9yYXdGaW5kKHF1ZXJ5LCB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAga2V5cyxcbiAgICAgIG1heFRpbWVNUyxcbiAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgaGludCxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgIGV4cGxhaW4sXG4gICAgfSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgLy8gQ2hlY2sgZm9yIFwibm8gZ2VvaW5kZXhcIiBlcnJvclxuICAgICAgaWYgKGVycm9yLmNvZGUgIT0gMTcwMDcgJiYgIWVycm9yLm1lc3NhZ2UubWF0Y2goL3VuYWJsZSB0byBmaW5kIGluZGV4IGZvciAuZ2VvTmVhci8pKSB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfVxuICAgICAgLy8gRmlndXJlIG91dCB3aGF0IGtleSBuZWVkcyBhbiBpbmRleFxuICAgICAgY29uc3Qga2V5ID0gZXJyb3IubWVzc2FnZS5tYXRjaCgvZmllbGQ9KFtBLVphLXpfMC05XSspIC8pWzFdO1xuICAgICAgaWYgKCFrZXkpIHtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG5cbiAgICAgIHZhciBpbmRleCA9IHt9O1xuICAgICAgaW5kZXhba2V5XSA9ICcyZCc7XG4gICAgICByZXR1cm4gKFxuICAgICAgICB0aGlzLl9tb25nb0NvbGxlY3Rpb25cbiAgICAgICAgICAuY3JlYXRlSW5kZXgoaW5kZXgpXG4gICAgICAgICAgLy8gUmV0cnksIGJ1dCBqdXN0IG9uY2UuXG4gICAgICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgICAgIHRoaXMuX3Jhd0ZpbmQocXVlcnksIHtcbiAgICAgICAgICAgICAgc2tpcCxcbiAgICAgICAgICAgICAgbGltaXQsXG4gICAgICAgICAgICAgIHNvcnQsXG4gICAgICAgICAgICAgIGtleXMsXG4gICAgICAgICAgICAgIG1heFRpbWVNUyxcbiAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgICAgIGNhc2VJbnNlbnNpdGl2ZSxcbiAgICAgICAgICAgICAgZXhwbGFpbixcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgKVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDb2xsYXRpb24gdG8gc3VwcG9ydCBjYXNlIGluc2Vuc2l0aXZlIHF1ZXJpZXNcbiAgICovXG4gIHN0YXRpYyBjYXNlSW5zZW5zaXRpdmVDb2xsYXRpb24oKSB7XG4gICAgcmV0dXJuIHsgbG9jYWxlOiAnZW5fVVMnLCBzdHJlbmd0aDogMiB9O1xuICB9XG5cbiAgX3Jhd0ZpbmQoXG4gICAgcXVlcnksXG4gICAgeyBza2lwLCBsaW1pdCwgc29ydCwga2V5cywgbWF4VGltZU1TLCByZWFkUHJlZmVyZW5jZSwgaGludCwgY2FzZUluc2Vuc2l0aXZlLCBleHBsYWluIH0gPSB7fVxuICApIHtcbiAgICBsZXQgZmluZE9wZXJhdGlvbiA9IHRoaXMuX21vbmdvQ29sbGVjdGlvbi5maW5kKHF1ZXJ5LCB7XG4gICAgICBza2lwLFxuICAgICAgbGltaXQsXG4gICAgICBzb3J0LFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgIH0pO1xuXG4gICAgaWYgKGtleXMpIHtcbiAgICAgIGZpbmRPcGVyYXRpb24gPSBmaW5kT3BlcmF0aW9uLnByb2plY3Qoa2V5cyk7XG4gICAgfVxuXG4gICAgaWYgKGNhc2VJbnNlbnNpdGl2ZSkge1xuICAgICAgZmluZE9wZXJhdGlvbiA9IGZpbmRPcGVyYXRpb24uY29sbGF0aW9uKE1vbmdvQ29sbGVjdGlvbi5jYXNlSW5zZW5zaXRpdmVDb2xsYXRpb24oKSk7XG4gICAgfVxuXG4gICAgaWYgKG1heFRpbWVNUykge1xuICAgICAgZmluZE9wZXJhdGlvbiA9IGZpbmRPcGVyYXRpb24ubWF4VGltZU1TKG1heFRpbWVNUyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGV4cGxhaW4gPyBmaW5kT3BlcmF0aW9uLmV4cGxhaW4oZXhwbGFpbikgOiBmaW5kT3BlcmF0aW9uLnRvQXJyYXkoKTtcbiAgfVxuXG4gIGNvdW50KHF1ZXJ5LCB7IHNraXAsIGxpbWl0LCBzb3J0LCBtYXhUaW1lTVMsIHJlYWRQcmVmZXJlbmNlLCBoaW50IH0gPSB7fSkge1xuICAgIC8vIElmIHF1ZXJ5IGlzIGVtcHR5LCB0aGVuIHVzZSBlc3RpbWF0ZWREb2N1bWVudENvdW50IGluc3RlYWQuXG4gICAgLy8gVGhpcyBpcyBkdWUgdG8gY291bnREb2N1bWVudHMgcGVyZm9ybWluZyBhIHNjYW4sXG4gICAgLy8gd2hpY2ggZ3JlYXRseSBpbmNyZWFzZXMgZXhlY3V0aW9uIHRpbWUgd2hlbiBiZWluZyBydW4gb24gbGFyZ2UgY29sbGVjdGlvbnMuXG4gICAgLy8gU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9BdXRvbWF0dGljL21vbmdvb3NlL2lzc3Vlcy82NzEzIGZvciBtb3JlIGluZm8gcmVnYXJkaW5nIHRoaXMgcHJvYmxlbS5cbiAgICBpZiAodHlwZW9mIHF1ZXJ5ICE9PSAnb2JqZWN0JyB8fCAhT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCkge1xuICAgICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5lc3RpbWF0ZWREb2N1bWVudENvdW50KHtcbiAgICAgICAgbWF4VGltZU1TLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3QgY291bnRPcGVyYXRpb24gPSB0aGlzLl9tb25nb0NvbGxlY3Rpb24uY291bnREb2N1bWVudHMocXVlcnksIHtcbiAgICAgIHNraXAsXG4gICAgICBsaW1pdCxcbiAgICAgIHNvcnQsXG4gICAgICBtYXhUaW1lTVMsXG4gICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgIGhpbnQsXG4gICAgfSk7XG5cbiAgICByZXR1cm4gY291bnRPcGVyYXRpb247XG4gIH1cblxuICBkaXN0aW5jdChmaWVsZCwgcXVlcnkpIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmRpc3RpbmN0KGZpZWxkLCBxdWVyeSk7XG4gIH1cblxuICBhZ2dyZWdhdGUocGlwZWxpbmUsIHsgbWF4VGltZU1TLCByZWFkUHJlZmVyZW5jZSwgaGludCwgZXhwbGFpbiB9ID0ge30pIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uXG4gICAgICAuYWdncmVnYXRlKHBpcGVsaW5lLCB7IG1heFRpbWVNUywgcmVhZFByZWZlcmVuY2UsIGhpbnQsIGV4cGxhaW4gfSlcbiAgICAgIC50b0FycmF5KCk7XG4gIH1cblxuICBpbnNlcnRPbmUob2JqZWN0LCBzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi5pbnNlcnRPbmUob2JqZWN0LCB7IHNlc3Npb24gfSk7XG4gIH1cblxuICAvLyBBdG9taWNhbGx5IHVwZGF0ZXMgZGF0YSBpbiB0aGUgZGF0YWJhc2UgZm9yIGEgc2luZ2xlIChmaXJzdCkgb2JqZWN0IHRoYXQgbWF0Y2hlZCB0aGUgcXVlcnlcbiAgLy8gSWYgdGhlcmUgaXMgbm90aGluZyB0aGF0IG1hdGNoZXMgdGhlIHF1ZXJ5IC0gZG9lcyBpbnNlcnRcbiAgLy8gUG9zdGdyZXMgTm90ZTogYElOU0VSVCAuLi4gT04gQ09ORkxJQ1QgVVBEQVRFYCB0aGF0IGlzIGF2YWlsYWJsZSBzaW5jZSA5LjUuXG4gIHVwc2VydE9uZShxdWVyeSwgdXBkYXRlLCBzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi51cGRhdGVPbmUocXVlcnksIHVwZGF0ZSwge1xuICAgICAgdXBzZXJ0OiB0cnVlLFxuICAgICAgc2Vzc2lvbixcbiAgICB9KTtcbiAgfVxuXG4gIHVwZGF0ZU9uZShxdWVyeSwgdXBkYXRlKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vbmdvQ29sbGVjdGlvbi51cGRhdGVPbmUocXVlcnksIHVwZGF0ZSk7XG4gIH1cblxuICB1cGRhdGVNYW55KHF1ZXJ5LCB1cGRhdGUsIHNlc3Npb24pIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLnVwZGF0ZU1hbnkocXVlcnksIHVwZGF0ZSwgeyBzZXNzaW9uIH0pO1xuICB9XG5cbiAgZGVsZXRlTWFueShxdWVyeSwgc2Vzc2lvbikge1xuICAgIHJldHVybiB0aGlzLl9tb25nb0NvbGxlY3Rpb24uZGVsZXRlTWFueShxdWVyeSwgeyBzZXNzaW9uIH0pO1xuICB9XG5cbiAgX2Vuc3VyZVNwYXJzZVVuaXF1ZUluZGV4SW5CYWNrZ3JvdW5kKGluZGV4UmVxdWVzdCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICB0aGlzLl9tb25nb0NvbGxlY3Rpb24uY3JlYXRlSW5kZXgoXG4gICAgICAgIGluZGV4UmVxdWVzdCxcbiAgICAgICAgeyB1bmlxdWU6IHRydWUsIGJhY2tncm91bmQ6IHRydWUsIHNwYXJzZTogdHJ1ZSB9LFxuICAgICAgICBlcnJvciA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXNvbHZlKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICApO1xuICAgIH0pO1xuICB9XG5cbiAgZHJvcCgpIHtcbiAgICByZXR1cm4gdGhpcy5fbW9uZ29Db2xsZWN0aW9uLmRyb3AoKTtcbiAgfVxufVxuIl19