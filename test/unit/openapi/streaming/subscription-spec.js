import { tick, global, installClock, uninstallClock } from '../../utils';
import mockTransport from '../../mocks/transport';

const Subscription = saxo.openapi._StreamingSubscription;

var transport;
var updateSpy, createdSpy, errorSpy;
var authManager;

function sendInitialResponse(response) {
    if (!response) {
        response = {Snapshot: {Data: [1,'fish',3]}};
    }
    transport.postResolve({ status: "200", response: response });
}

describe("openapi StreamingSubscription", () => {
    beforeEach(() => {
        installClock();
        transport = mockTransport();
        updateSpy = jasmine.createSpy("update");
        createdSpy = jasmine.createSpy("create");
        errorSpy = jasmine.createSpy("error");
        authManager = jasmine.createSpyObj('authManager', ['getAuth']);
        authManager.getAuth.and.callFake(function() {
            return {token: "TOKEN"};
        });
    });
    afterEach(function() {
        uninstallClock();
    });

    describe("options", () => {
        it("accepts a refresh rate", () => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', { RefreshRate: 120 });
            subscription.onSubscribe();

            expect(transport.post.calls.count()).toEqual(1);
            expect(transport.post.calls.argsFor(0)).toEqual(['serviceGroup', 'test/resource/active', null, jasmine.objectContaining({ body: jasmine.objectContaining({ RefreshRate: 120 }) })]);
        });
        it("has a minimum refresh rate", () => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', { RefreshRate: 1 });
            subscription.onSubscribe();

            expect(transport.post.calls.count()).toEqual(1);
            expect(transport.post.calls.argsFor(0)).toEqual(['serviceGroup', 'test/resource/active', null, jasmine.objectContaining({ body: jasmine.objectContaining({ RefreshRate: 100 }) })]);
        });
    });

    describe("initial snapshot", () => {
        it("handles snapshots containing an array of data ", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            var initialResponse = {Snapshot: {Data: [1,'fish',3]}};
            sendInitialResponse(initialResponse);

            tick(() => {
                // the update function should be called once with all data
                expect(updateSpy.calls.count()).toEqual(1);
                expect(updateSpy.calls.argsFor(0)).toEqual([{ Data: [1,'fish',3]}, subscription.UPDATE_TYPE_SNAPSHOT]);
                done();
            });
        });

        it("handles snapshots containing a single datum", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup','test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            var initialResponse = {Snapshot: 'wibble' };
            sendInitialResponse(initialResponse);

            tick(() => {
                expect(updateSpy.calls.count()).toEqual(1);
                expect(updateSpy.calls.argsFor(0)).toEqual(["wibble", subscription.UPDATE_TYPE_SNAPSHOT]);
                done();
            });
        });

        it("handles errors", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, null, errorSpy);
            subscription.onSubscribe();

            transport.postReject({ status: "401", response: { message: "An error has occurred"}});

            tick(() => {
                expect(errorSpy.calls.count()).toEqual(1);
                expect(errorSpy.calls.argsFor(0)).toEqual([{ status: "401", response: { message: "An error has occurred"}}]);
                done();
            });
        });

        it("catches exceptions thrown during initial update", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            updateSpy.and.throwError("Unhandled Exception");

            var initialResponse = {Snapshot: {Data: [1,'fish',3]}};
            sendInitialResponse(initialResponse);

            tick(() => {

                expect(updateSpy.calls.count()).toEqual(1);

                const streamingData = {ReferenceId: subscription.referenceId, Data: [1, 3]};
                subscription.onStreamingData(streamingData);

                // check we have not artificiailly set the streaming state as unsubscribed
                expect(updateSpy.calls.count()).toEqual(2);

                done();
            });
        });
    });

    describe("streamed update", () => {
        var subscription;
        beforeEach((done) => {
            subscription = new Subscription('123',  transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();
            sendInitialResponse({ Snapshot: { Data: [] }});
            tick(() => {
                updateSpy.calls.reset();
                done();
            });
        });

        it("handles updates with the correct referenceId", () => {
            const streamingData = {ReferenceId: subscription.referenceId, Data: [1, 3]};
            subscription.onStreamingData(streamingData);

            // the update function should be called once
            expect(updateSpy.calls.count()).toEqual(1);
            expect(updateSpy.calls.argsFor(0)).toEqual([streamingData, subscription.UPDATE_TYPE_DELTA]);
        });

        it("handles single-valued updates", () => {
            const streamingData = {ReferenceId: subscription.referenceId, Data: ['foo']};
            subscription.onStreamingData(streamingData);

            expect(updateSpy.calls.count()).toEqual(1);
            expect(updateSpy.calls.argsFor(0)).toEqual([streamingData, subscription.UPDATE_TYPE_DELTA]);
        });

        it("catches exceptions thrown during updates", () => {
            updateSpy.and.throwError("Unhandled Exception");

            expect(() => subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: 'foo'}))
                .not.toThrowError();
        });

        it("handles an unsubscribe from streaming data callback", () => {
            updateSpy.and.callFake(() => subscription.onUnsubscribe());

            subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: 'foo'});
            subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: 'foo'});

            expect(updateSpy.calls.count()).toEqual(1);
            expect(transport.delete.calls.count()).toEqual(1);
        });
    });

    describe("out of order behaviour", () => {
        it("handles getting a delta before an initial response", (done) => {
            var subscription = new Subscription('123',  transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            var streamingDelta = {ReferenceId: subscription.referenceId, Data: ['foo']};
            subscription.onStreamingData(streamingDelta);

            var initialResponse = {Snapshot: {Data: [1,'fish',3]}};
            sendInitialResponse(initialResponse);

            tick(() => {

                expect(updateSpy.calls.count()).toEqual(2);
                expect(updateSpy.calls.argsFor(0)).toEqual([initialResponse.Snapshot, subscription.UPDATE_TYPE_SNAPSHOT]);
                expect(updateSpy.calls.argsFor(1)).toEqual([streamingDelta, subscription.UPDATE_TYPE_DELTA]);
                done();
            });
        });
        it("ignores updates when unsubscribed", (done) => {
            var subscription = new Subscription('123',  transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: 'foo'});
            expect(updateSpy.calls.count()).toEqual(0);

            subscription.onSubscribe();

            var initialResponse = {Snapshot: {Data: [1,'fish',3]}};
            sendInitialResponse(initialResponse);

            tick(() => {

                expect(updateSpy.calls.count()).toEqual(1);

                subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: 'foo'});

                expect(updateSpy.calls.count()).toEqual(2);

                subscription.onUnsubscribe();

                subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: 'foo'});

                expect(updateSpy.calls.count()).toEqual(2);

                done();
            });
        });
        it("ignores snapshot when unsubscribed", (done) => {
            var subscription = new Subscription('123',  transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.onSubscribe();
            subscription.onUnsubscribe();

            subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: 'foo'});
            var initialResponse = {Snapshot: {Data: [1,'fish',3]}};
            sendInitialResponse(initialResponse);

            tick(() => {
                expect(updateSpy.calls.count()).toEqual(0);
                done();
            });
        });
        it("throws an error if you subscribe when disposed", () => {
            var subscription = new Subscription('123',  transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.onSubscribe();
            subscription.onUnsubscribe();
            subscription.dispose();

            expect(() => subscription.onSubscribe()).toThrow();
        });
    });

    describe("connection unavailable behaviour", () => {
        it ("does not subscribe when the connection is unavailable", () => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onConnectionUnavailable();
            subscription.onSubscribe();
            expect(transport.post.calls.count()).toEqual(0);
        });
        it ("does not unsubscribe when the connection is unavailable", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            expect(transport.post.calls.count()).toEqual(1);

            sendInitialResponse();

            tick(() => {
                // now subscribed.

                subscription.onConnectionUnavailable();
                subscription.onUnsubscribe();

                expect(transport.delete.calls.count()).toEqual(0);

                subscription.onConnectionAvailable();
                expect(transport.delete.calls.count()).toEqual(1);

                done();
            });
        });
        it ("does not unsubscribe if connection becomes unavailable whilst subscribing", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();
            subscription.onConnectionUnavailable();
            subscription.onUnsubscribe();

            expect(transport.delete.calls.count()).toEqual(0);

            sendInitialResponse();

            tick(() => {
                // now subscribed.
                expect(transport.delete.calls.count()).toEqual(0);

                subscription.onConnectionAvailable();

                expect(transport.delete.calls.count()).toEqual(1);

                done();
            });
        });
        it ("does not subscribe if connection becomes unavailable whilst unsubscribing", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();
            expect(transport.post.calls.count()).toEqual(1);
            transport.post.calls.reset();

            sendInitialResponse();

            tick(() => {
                // now subscribed.

                subscription.onUnsubscribe();
                expect(transport.delete.calls.count()).toEqual(1);

                subscription.onConnectionUnavailable();
                subscription.onSubscribe();
                expect(transport.post.calls.count()).toEqual(0);

                transport.deleteResolve({status: 200});

                tick(() => {
                    expect(transport.post.calls.count()).toEqual(0);

                    subscription.onConnectionAvailable();

                    expect(transport.post.calls.count()).toEqual(1);

                    done();
                });
            });
        });
    });

    describe("subscribe/unsubscribe queuing", () => {

        it ("ignores multiple commands when already in the right state", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            spyOn(saxo.log, "error");

            subscription.onUnsubscribe();
            subscription.onUnsubscribe();
            subscription.onUnsubscribe();
            subscription.onUnsubscribe();

            expect(transport.post.calls.count()).toEqual(0);
            expect(transport.delete.calls.count()).toEqual(0);

            subscription.onSubscribe(); // subscribing
            transport.post.calls.reset();
            // waiting for subscribe to respond

            subscription.onSubscribe();
            subscription.onSubscribe();
            subscription.onSubscribe();
            subscription.onSubscribe();

            expect(transport.post.calls.count()).toEqual(0);
            expect(transport.delete.calls.count()).toEqual(0);

            sendInitialResponse();
            tick(() => {

                // now subscribed
                subscription.onSubscribe();
                subscription.onSubscribe();
                subscription.onSubscribe();
                subscription.onSubscribe();

                expect(transport.post.calls.count()).toEqual(0);
                expect(transport.delete.calls.count()).toEqual(0);

                subscription.onUnsubscribe(); // unsubscribing
                transport.delete.calls.reset();
                // waiting for unsubscribe

                subscription.onUnsubscribe();
                subscription.onUnsubscribe();
                subscription.onUnsubscribe();
                subscription.onUnsubscribe();

                expect(transport.post.calls.count()).toEqual(0);
                expect(transport.delete.calls.count()).toEqual(0);

                transport.deleteResolve({status: 200});
                tick(() => {
                    // now unsubscribed

                    subscription.onUnsubscribe();
                    subscription.onUnsubscribe();
                    subscription.onUnsubscribe();
                    subscription.onUnsubscribe();

                    expect(transport.post.calls.count()).toEqual(0);
                    expect(transport.delete.calls.count()).toEqual(0);

                    expect(saxo.log.error.calls.count()).toEqual(0);

                    done();
                });
            });
        });

        /**
         * Unsubscribe before subscribe is required for modify action.
          */
        it ("accept unsubscribe followed by a subscribe when waiting for an action to respond", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            spyOn(saxo.log, "error");

            subscription.onSubscribe();
            transport.post.calls.reset();
            // waiting for subscribe to respond

            subscription.onUnsubscribe();
            subscription.onSubscribe();

            sendInitialResponse();
            tick(() => {

                expect(transport.post.calls.count()).toEqual(0);
                expect(transport.delete.calls.count()).toEqual(0);

                expect(saxo.log.error.calls.count()).toEqual(0);

                done();
            });
        });

        it ("if an error occurs unsubscribing then it continues with the next action", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.onSubscribe();

            sendInitialResponse();
            tick(() => {
                subscription.onUnsubscribe();
                subscription.onSubscribe();

                transport.deleteReject();
                transport.post.calls.reset();

                tick(() => {
                    expect(transport.post.calls.count()).toEqual(1); // it does the subscribe after the unsubscribe fails
                    done();
                });
            });
        });

        it ("ignores a subscribe followed by an unsubscribe when waiting for an action to respond", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            spyOn(saxo.log, "error");

            subscription.onSubscribe();
            transport.post.calls.reset();

            sendInitialResponse();
            tick(() => {

                subscription.onUnsubscribe();
                transport.delete.calls.reset();
                // waiting for unsubscribe to occur

                subscription.onSubscribe();
                subscription.onUnsubscribe();

                expect(transport.post.calls.count()).toEqual(0);
                expect(transport.delete.calls.count()).toEqual(0);

                transport.deleteResolve({status: 200});

                tick(() => {

                    expect(transport.post.calls.count()).toEqual(0);
                    expect(transport.delete.calls.count()).toEqual(0);

                    expect(saxo.log.error.calls.count()).toEqual(0);

                    done();
                });
            });
        });
    });

    describe("activity detection", () => {
        it("has an infinite time till when unsubscribed, subscribing and unsubscribed", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);
            subscription.onSubscribe();
            expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);
            jasmine.clock().tick(50);
            expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);

            sendInitialResponse({InactivityTimeout: 100, Snapshot: {}});
            tick(() => {
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(100 * 1000);
                jasmine.clock().tick(10);
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(100 * 1000 - 10);

                subscription.onUnsubscribe();
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);

                transport.deleteResolve({status: 200});
                tick(() => {
                    expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);
                    subscription.onSubscribe();
                    expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);

                    sendInitialResponse({InactivityTimeout: 100, Snapshot: {}});
                    tick(() => {
                        expect(subscription.timeTillOrphaned(Date.now())).toEqual(100 * 1000);

                        done();
                    });
                });
            });
        });
        it("has an infinite time when there is no inactivity timeout", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            sendInitialResponse({InactivityTimeout: 0, Snapshot: {}});
            tick(() => {
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);
                done();
            });
        });
        it("has an infinite time when the connection is unavailable", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            sendInitialResponse({InactivityTimeout: 10, Snapshot: {}});
            tick(() => {
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(10 * 1000);
                subscription.onConnectionUnavailable();
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(Infinity);
                done();
            });
        });

        it("counts data updates as an activity", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            sendInitialResponse({InactivityTimeout: 10, Snapshot: {}});
            tick(() => {
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(10 * 1000);
                jasmine.clock().tick(9000);

                expect(subscription.timeTillOrphaned(Date.now())).toEqual(1 * 1000);
                subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: [1, 3]});
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(10 * 1000);

                jasmine.clock().tick(4956);
                subscription.onStreamingData({ReferenceId: subscription.referenceId, Data: [1, 3]});
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(10 * 1000);

                done();
            });
        });
        it("counts heartbeats as an activity", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);
            subscription.onSubscribe();

            sendInitialResponse({InactivityTimeout: 10, Snapshot: {}});
            tick(() => {
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(10 * 1000);
                jasmine.clock().tick(9000);

                expect(subscription.timeTillOrphaned(Date.now())).toEqual(1 * 1000);
                subscription.onHeartbeat();
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(10 * 1000);

                jasmine.clock().tick(4956);
                subscription.onHeartbeat();
                expect(subscription.timeTillOrphaned(Date.now())).toEqual(10 * 1000);

                done();
            });
        });
    });

    describe("reset behaviour", () => {
        it("does nothing if unsubscribed or unsubscribing", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.reset(); //reset before subscribed

            expect(transport.post.calls.count()).toEqual(0);
            expect(transport.delete.calls.count()).toEqual(0);

            subscription.onSubscribe();

            sendInitialResponse({InactivityTimeout: 100, Snapshot: {}});
            tick(() => {

                subscription.onUnsubscribe();

                expect(transport.post.calls.count()).toEqual(1);
                transport.post.calls.reset();
                expect(transport.delete.calls.count()).toEqual(1);
                transport.delete.calls.reset();

                let oldReferenceId = subscription.referenceId;
                subscription.reset(); // reset when trying to unsubscribe
                expect(oldReferenceId).toEqual(subscription.referenceId); // don't need to change as not subscribing

                expect(transport.post.calls.count()).toEqual(0);
                expect(transport.delete.calls.count()).toEqual(0);

                transport.deleteResolve({status: 200});
                tick(() => {

                    let oldReferenceId = subscription.referenceId;
                    subscription.reset(); //reset when unsubscribed
                    expect(oldReferenceId).toEqual(subscription.referenceId); // don't need to change as not subscribing

                    expect(transport.post.calls.count()).toEqual(0);
                    expect(transport.delete.calls.count()).toEqual(0);

                    done();
                });
            });
        });

        it("subscribes if in the process of subscribing", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.onSubscribe();

            expect(transport.post.calls.count()).toEqual(1);
            transport.post.calls.reset();
            expect(transport.delete.calls.count()).toEqual(0);
            var resolveToInitialSubscribe = transport.postResolve;

            let oldReferenceId = subscription.referenceId;
            subscription.reset(); //reset before subscribe response
            expect(oldReferenceId).not.toEqual(subscription.referenceId);


            expect(transport.post.calls.count()).toEqual(1);
            transport.post.calls.reset();
            expect(transport.delete.calls.count()).toEqual(0);

            resolveToInitialSubscribe({ status: 201, response: { Snapshot: { initial: true }}});

            sendInitialResponse({InactivityTimeout: 100, Snapshot: { resetResponse: true }});
            tick(() => {

                expect(errorSpy.calls.count()).toEqual(0);

                expect(updateSpy.calls.count()).toEqual(1);
                expect(updateSpy.calls.argsFor(0)).toEqual([{ resetResponse: true }, subscription.UPDATE_TYPE_SNAPSHOT]);

                done();
            });
        });

        it("subscribes if in the process of subscribing and handles a reject on an old subscription request", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.onSubscribe();

            expect(transport.post.calls.count()).toEqual(1);
            transport.post.calls.reset();
            expect(transport.delete.calls.count()).toEqual(0);
            var rejectToInitialSubscribe = transport.postReject;

            let oldReferenceId = subscription.referenceId;
            subscription.reset(); //reset before subscribe response
            expect(oldReferenceId).not.toEqual(subscription.referenceId);


            expect(transport.post.calls.count()).toEqual(1);
            transport.post.calls.reset();
            expect(transport.delete.calls.count()).toEqual(0);

            rejectToInitialSubscribe({ status: 401 });

            sendInitialResponse({InactivityTimeout: 100, Snapshot: { resetResponse: true }});
            tick(() => {

                expect(errorSpy.calls.count()).toEqual(0);

                expect(updateSpy.calls.count()).toEqual(1);
                expect(updateSpy.calls.argsFor(0)).toEqual([{ resetResponse: true }, subscription.UPDATE_TYPE_SNAPSHOT]);

                done();
            });
        });

        it("subscribes if currently subscribed", (done) => {
            var subscription = new Subscription('123', transport, 'serviceGroup', 'test/resource', {}, createdSpy, updateSpy);

            subscription.onSubscribe();

            expect(transport.post.calls.count()).toEqual(1);
            transport.post.calls.reset();
            expect(transport.delete.calls.count()).toEqual(0);

            sendInitialResponse({InactivityTimeout: 100, Snapshot: { resetResponse: true }});
            tick(() => {
                // normally subscribed

                let oldReferenceId = subscription.referenceId;
                subscription.reset();
                expect(oldReferenceId).not.toEqual(subscription.referenceId);

                // sent off another new request for a subscription
                expect(transport.post.calls.count()).toEqual(1);
                transport.post.calls.reset();
                expect(transport.delete.calls.count()).toEqual(0);

                done();
            });

        });
    });
});
