const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Basic info endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'MediaSoup VR Streaming Server',
    status: 'running',
    connections: io.engine.clientsCount
  });
});

// MediaSoup configuration - Updated for Render
const config = {
  worker: {
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
    logLevel: 'debug', // Reduced logging for production
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp',
    ],
  },
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/h264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032',
          'level-asymmetry-allowed': 1,
          'x-google-start-bitrate': 1000,
        },
      },
    ],
  },
  webRtcTransport: {
    listenIps: [
      {
        ip: '0.0.0.0',
        announcedIp: process.env.ANNOUNCED_IP || undefined, // Will be set by Render
      },
    ],
    maxIncomingBitrate: 1500000,
    initialAvailableOutgoingBitrate: 1000000,
  },
};

let worker;
let router;
const producers = new Map();
const consumers = new Map();
const transports = new Map();

// Initialize MediaSoup
async function initializeMediaSoup() {
  try {
    // Create worker
    worker = await mediasoup.createWorker({
      logLevel: config.worker.logLevel,
      logTags: config.worker.logTags,
      rtcMinPort: config.worker.rtcMinPort,
      rtcMaxPort: config.worker.rtcMaxPort,
    });

    console.log('MediaSoup worker created');

    worker.on('died', () => {
      console.error('MediaSoup worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });

    // Create router
    router = await worker.createRouter({
      mediaCodecs: config.router.mediaCodecs,
    });

    console.log('MediaSoup router created');
  } catch (error) {
    console.error('Error creating MediaSoup worker/router:', error);
    throw error;
  }
}

// Socket.IO connection handling with improved error handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Get RTP capabilities
  socket.on('getRouterRtpCapabilities', (callback) => {
    try {
      callback(router.rtpCapabilities);
    } catch (error) {
      console.error('Error getting RTP capabilities:', error);
      callback({ error: error.message });
    }
  });

  // Create WebRTC transport for producer (VR device)
  socket.on('createProducerTransport', async (callback) => {
    try {
      const transport = await createWebRtcTransport(router);
      transports.set(transport.id, transport);

      // Store transport reference for this socket
      socket.producerTransport = transport;

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (error) {
      console.error('Error creating producer transport:', error);
      callback({ error: error.message });
    }
  });

  // Create WebRTC transport for consumer (frontend)
  socket.on('createConsumerTransport', async (callback) => {
    try {
      const transport = await createWebRtcTransport(router);
      transports.set(transport.id, transport);

      // Store transport reference for this socket
      socket.consumerTransport = transport;

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });
    } catch (error) {
      console.error('Error creating consumer transport:', error);
      callback({ error: error.message });
    }
  });

  // Connect producer transport
  socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
    try {
      if (!socket.producerTransport) {
        throw new Error('Producer transport not found');
      }
      await socket.producerTransport.connect({ dtlsParameters });
      callback();
    } catch (error) {
      console.error('Error connecting producer transport:', error);
      callback({ error: error.message });
    }
  });

  // Connect consumer transport
  socket.on('connectConsumerTransport', async ({ dtlsParameters }, callback) => {
    try {
      if (!socket.consumerTransport) {
        throw new Error('Consumer transport not found');
      }
      await socket.consumerTransport.connect({ dtlsParameters });
      callback();
    } catch (error) {
      console.error('Error connecting consumer transport:', error);
      callback({ error: error.message });
    }
  });

  // Produce media (from VR)
  socket.on('produce', async ({ kind, rtpParameters }, callback) => {
    try {
      if (!socket.producerTransport) {
        throw new Error('Producer transport not found');
      }

      const producer = await socket.producerTransport.produce({
        kind,
        rtpParameters,
      });

      console.log('Producer created:', producer.id, producer.kind);
      producers.set(producer.id, producer);
      socket.producer = producer;

      producer.on('transportclose', () => {
        console.log('Producer transport closed:', producer.id);
        producers.delete(producer.id);
      });

      callback({ id: producer.id });

      // Inform other clients about new producer
      socket.broadcast.emit('newProducer', { producerId: producer.id });
    } catch (error) {
      console.error('Error creating producer:', error);
      callback({ error: error.message });
    }
  });

  // Consume media (for frontend)
  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      // Find any available producer
      const producer = Array.from(producers.values())[0];
      
      if (!producer) {
        return callback({ error: 'No producer available' });
      }

      if (!socket.consumerTransport) {
        return callback({ error: 'Consumer transport not found' });
      }

      if (router.canConsume({
        producerId: producer.id,
        rtpCapabilities,
      })) {
        const consumer = await socket.consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });

        consumers.set(consumer.id, consumer);
        socket.consumer = consumer;

        consumer.on('transportclose', () => {
          console.log('Consumer transport closed:', consumer.id);
          consumers.delete(consumer.id);
        });

        consumer.on('producerclose', () => {
          console.log('Consumer closed due to producer close:', consumer.id);
          consumers.delete(consumer.id);
          socket.emit('producerClosed');
        });

        const params = {
          producerId: producer.id,
          id: consumer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        callback({ params });
      } else {
        callback({ error: 'Cannot consume' });
      }
    } catch (error) {
      console.error('Error creating consumer:', error);
      callback({ error: error.message });
    }
  });

  // Resume consumer
  socket.on('resumeConsumer', async (callback) => {
    try {
      if (!socket.consumer) {
        throw new Error('Consumer not found');
      }
      await socket.consumer.resume();
      console.log('Consumer resumed:', socket.consumer.id);
      callback();
    } catch (error) {
      console.error('Error resuming consumer:', error);
      callback({ error: error.message });
    }
  });

  // Handle disconnect with cleanup
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Cleanup transports
    if (socket.producerTransport) {
      socket.producerTransport.close();
    }
    if (socket.consumerTransport) {
      socket.consumerTransport.close();
    }
    
    // Cleanup producer/consumer
    if (socket.producer) {
      producers.delete(socket.producer.id);
    }
    if (socket.consumer) {
      consumers.delete(socket.consumer.id);
    }
  });
});

// Helper function to create WebRTC transport
async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport({
    listenIps: config.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    maxIncomingBitrate: config.webRtcTransport.maxIncomingBitrate,
    initialAvailableOutgoingBitrate: config.webRtcTransport.initialAvailableOutgoingBitrate,
  });

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'closed') {
      transport.close();
    }
  });

  transport.on('close', () => {
    console.log('Transport closed');
  });

  return transport;
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  
  if (worker) {
    worker.close();
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  
  if (worker) {
    worker.close();
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeMediaSoup();
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`MediaSoup server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Announced IP: ${process.env.ANNOUNCED_IP || 'auto-detect'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
