"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.EventEmitterPubSub = void 0;

var _events = _interopRequireDefault(require("events"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const emitter = new _events.default.EventEmitter();

class Publisher {
  constructor(emitter) {
    this.emitter = emitter;
  }

  publish(channel, message) {
    this.emitter.emit(channel, message);
  }

}

class Subscriber extends _events.default.EventEmitter {
  constructor(emitter) {
    super();
    this.emitter = emitter;
    this.subscriptions = new Map();
  }

  subscribe(channel) {
    const handler = message => {
      this.emit('message', channel, message);
    };

    this.subscriptions.set(channel, handler);
    this.emitter.on(channel, handler);
  }

  unsubscribe(channel) {
    if (!this.subscriptions.has(channel)) {
      return;
    }

    this.emitter.removeListener(channel, this.subscriptions.get(channel));
    this.subscriptions.delete(channel);
  }

}

function createPublisher() {
  return new Publisher(emitter);
}

function createSubscriber() {
  // createSubscriber is called once at live query server start
  // to avoid max listeners warning, we should clean up the event emitter
  // each time this function is called
  emitter.removeAllListeners();
  return new Subscriber(emitter);
}

const EventEmitterPubSub = {
  createPublisher,
  createSubscriber
};
exports.EventEmitterPubSub = EventEmitterPubSub;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9BZGFwdGVycy9QdWJTdWIvRXZlbnRFbWl0dGVyUHViU3ViLmpzIl0sIm5hbWVzIjpbImVtaXR0ZXIiLCJldmVudHMiLCJFdmVudEVtaXR0ZXIiLCJQdWJsaXNoZXIiLCJjb25zdHJ1Y3RvciIsInB1Ymxpc2giLCJjaGFubmVsIiwibWVzc2FnZSIsImVtaXQiLCJTdWJzY3JpYmVyIiwic3Vic2NyaXB0aW9ucyIsIk1hcCIsInN1YnNjcmliZSIsImhhbmRsZXIiLCJzZXQiLCJvbiIsInVuc3Vic2NyaWJlIiwiaGFzIiwicmVtb3ZlTGlzdGVuZXIiLCJnZXQiLCJkZWxldGUiLCJjcmVhdGVQdWJsaXNoZXIiLCJjcmVhdGVTdWJzY3JpYmVyIiwicmVtb3ZlQWxsTGlzdGVuZXJzIiwiRXZlbnRFbWl0dGVyUHViU3ViIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7Ozs7QUFFQSxNQUFNQSxPQUFPLEdBQUcsSUFBSUMsZ0JBQU9DLFlBQVgsRUFBaEI7O0FBRUEsTUFBTUMsU0FBTixDQUFnQjtBQUdkQyxFQUFBQSxXQUFXLENBQUNKLE9BQUQsRUFBZTtBQUN4QixTQUFLQSxPQUFMLEdBQWVBLE9BQWY7QUFDRDs7QUFFREssRUFBQUEsT0FBTyxDQUFDQyxPQUFELEVBQWtCQyxPQUFsQixFQUF5QztBQUM5QyxTQUFLUCxPQUFMLENBQWFRLElBQWIsQ0FBa0JGLE9BQWxCLEVBQTJCQyxPQUEzQjtBQUNEOztBQVRhOztBQVloQixNQUFNRSxVQUFOLFNBQXlCUixnQkFBT0MsWUFBaEMsQ0FBNkM7QUFJM0NFLEVBQUFBLFdBQVcsQ0FBQ0osT0FBRCxFQUFlO0FBQ3hCO0FBQ0EsU0FBS0EsT0FBTCxHQUFlQSxPQUFmO0FBQ0EsU0FBS1UsYUFBTCxHQUFxQixJQUFJQyxHQUFKLEVBQXJCO0FBQ0Q7O0FBRURDLEVBQUFBLFNBQVMsQ0FBQ04sT0FBRCxFQUF3QjtBQUMvQixVQUFNTyxPQUFPLEdBQUdOLE9BQU8sSUFBSTtBQUN6QixXQUFLQyxJQUFMLENBQVUsU0FBVixFQUFxQkYsT0FBckIsRUFBOEJDLE9BQTlCO0FBQ0QsS0FGRDs7QUFHQSxTQUFLRyxhQUFMLENBQW1CSSxHQUFuQixDQUF1QlIsT0FBdkIsRUFBZ0NPLE9BQWhDO0FBQ0EsU0FBS2IsT0FBTCxDQUFhZSxFQUFiLENBQWdCVCxPQUFoQixFQUF5Qk8sT0FBekI7QUFDRDs7QUFFREcsRUFBQUEsV0FBVyxDQUFDVixPQUFELEVBQXdCO0FBQ2pDLFFBQUksQ0FBQyxLQUFLSSxhQUFMLENBQW1CTyxHQUFuQixDQUF1QlgsT0FBdkIsQ0FBTCxFQUFzQztBQUNwQztBQUNEOztBQUNELFNBQUtOLE9BQUwsQ0FBYWtCLGNBQWIsQ0FBNEJaLE9BQTVCLEVBQXFDLEtBQUtJLGFBQUwsQ0FBbUJTLEdBQW5CLENBQXVCYixPQUF2QixDQUFyQztBQUNBLFNBQUtJLGFBQUwsQ0FBbUJVLE1BQW5CLENBQTBCZCxPQUExQjtBQUNEOztBQXhCMEM7O0FBMkI3QyxTQUFTZSxlQUFULEdBQWdDO0FBQzlCLFNBQU8sSUFBSWxCLFNBQUosQ0FBY0gsT0FBZCxDQUFQO0FBQ0Q7O0FBRUQsU0FBU3NCLGdCQUFULEdBQWlDO0FBQy9CO0FBQ0E7QUFDQTtBQUNBdEIsRUFBQUEsT0FBTyxDQUFDdUIsa0JBQVI7QUFDQSxTQUFPLElBQUlkLFVBQUosQ0FBZVQsT0FBZixDQUFQO0FBQ0Q7O0FBRUQsTUFBTXdCLGtCQUFrQixHQUFHO0FBQ3pCSCxFQUFBQSxlQUR5QjtBQUV6QkMsRUFBQUE7QUFGeUIsQ0FBM0IiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgZXZlbnRzIGZyb20gJ2V2ZW50cyc7XG5cbmNvbnN0IGVtaXR0ZXIgPSBuZXcgZXZlbnRzLkV2ZW50RW1pdHRlcigpO1xuXG5jbGFzcyBQdWJsaXNoZXIge1xuICBlbWl0dGVyOiBhbnk7XG5cbiAgY29uc3RydWN0b3IoZW1pdHRlcjogYW55KSB7XG4gICAgdGhpcy5lbWl0dGVyID0gZW1pdHRlcjtcbiAgfVxuXG4gIHB1Ymxpc2goY2hhbm5lbDogc3RyaW5nLCBtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmVtaXR0ZXIuZW1pdChjaGFubmVsLCBtZXNzYWdlKTtcbiAgfVxufVxuXG5jbGFzcyBTdWJzY3JpYmVyIGV4dGVuZHMgZXZlbnRzLkV2ZW50RW1pdHRlciB7XG4gIGVtaXR0ZXI6IGFueTtcbiAgc3Vic2NyaXB0aW9uczogYW55O1xuXG4gIGNvbnN0cnVjdG9yKGVtaXR0ZXI6IGFueSkge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5lbWl0dGVyID0gZW1pdHRlcjtcbiAgICB0aGlzLnN1YnNjcmlwdGlvbnMgPSBuZXcgTWFwKCk7XG4gIH1cblxuICBzdWJzY3JpYmUoY2hhbm5lbDogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgaGFuZGxlciA9IG1lc3NhZ2UgPT4ge1xuICAgICAgdGhpcy5lbWl0KCdtZXNzYWdlJywgY2hhbm5lbCwgbWVzc2FnZSk7XG4gICAgfTtcbiAgICB0aGlzLnN1YnNjcmlwdGlvbnMuc2V0KGNoYW5uZWwsIGhhbmRsZXIpO1xuICAgIHRoaXMuZW1pdHRlci5vbihjaGFubmVsLCBoYW5kbGVyKTtcbiAgfVxuXG4gIHVuc3Vic2NyaWJlKGNoYW5uZWw6IHN0cmluZyk6IHZvaWQge1xuICAgIGlmICghdGhpcy5zdWJzY3JpcHRpb25zLmhhcyhjaGFubmVsKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLmVtaXR0ZXIucmVtb3ZlTGlzdGVuZXIoY2hhbm5lbCwgdGhpcy5zdWJzY3JpcHRpb25zLmdldChjaGFubmVsKSk7XG4gICAgdGhpcy5zdWJzY3JpcHRpb25zLmRlbGV0ZShjaGFubmVsKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVQdWJsaXNoZXIoKTogYW55IHtcbiAgcmV0dXJuIG5ldyBQdWJsaXNoZXIoZW1pdHRlcik7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVN1YnNjcmliZXIoKTogYW55IHtcbiAgLy8gY3JlYXRlU3Vic2NyaWJlciBpcyBjYWxsZWQgb25jZSBhdCBsaXZlIHF1ZXJ5IHNlcnZlciBzdGFydFxuICAvLyB0byBhdm9pZCBtYXggbGlzdGVuZXJzIHdhcm5pbmcsIHdlIHNob3VsZCBjbGVhbiB1cCB0aGUgZXZlbnQgZW1pdHRlclxuICAvLyBlYWNoIHRpbWUgdGhpcyBmdW5jdGlvbiBpcyBjYWxsZWRcbiAgZW1pdHRlci5yZW1vdmVBbGxMaXN0ZW5lcnMoKTtcbiAgcmV0dXJuIG5ldyBTdWJzY3JpYmVyKGVtaXR0ZXIpO1xufVxuXG5jb25zdCBFdmVudEVtaXR0ZXJQdWJTdWIgPSB7XG4gIGNyZWF0ZVB1Ymxpc2hlcixcbiAgY3JlYXRlU3Vic2NyaWJlcixcbn07XG5cbmV4cG9ydCB7IEV2ZW50RW1pdHRlclB1YlN1YiB9O1xuIl19