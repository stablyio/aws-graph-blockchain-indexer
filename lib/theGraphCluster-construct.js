// © 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
// This AWS Content is provided subject to the terms of the AWS Customer Agreement
// available at http://aws.amazon.com/agreement or other written agreement between
// Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.

require('./config.js')
const path = require('path')
const {
  RemovalPolicy,
  Duration,
  CustomResource,
  Stack,
  Tags,
  SecretValue,
} = require('aws-cdk-lib')
const { AutoScalingGroup } = require('aws-cdk-lib/aws-autoscaling')
const {
  Vpc,
  Peer,
  Port,
  InstanceType,
  SecurityGroup,
  SubnetType,
  LaunchTemplate,
  UserData,
  InterfaceVpcEndpointAwsService,
  EbsDeviceVolumeType,
  BlockDeviceVolume,
} = require('aws-cdk-lib/aws-ec2')
const {
  Cluster,
  EcsOptimizedImage,
  AsgCapacityProvider,
  Ec2TaskDefinition,
  LogDrivers,
  ContainerImage,
  Protocol,
  Secret,
  ContainerDependencyCondition,
  FargateService,
  NetworkMode,
  FargateTaskDefinition,
} = require('aws-cdk-lib/aws-ecs')
const {
  Role,
  ServicePrincipal,
  ManagedPolicy,
  PolicyStatement,
  AnyPrincipal,
} = require('aws-cdk-lib/aws-iam')
const { Runtime, Architecture } = require('aws-cdk-lib/aws-lambda')
const { NodejsFunction } = require('aws-cdk-lib/aws-lambda-nodejs')
const {
  DatabaseCluster,
  DatabaseClusterEngine,
  AuroraPostgresEngineVersion,
  ParameterGroup,
  ClusterInstance,
} = require('aws-cdk-lib/aws-rds')
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager')
const { Construct } = require('constructs')
const { Provider } = require('aws-cdk-lib/custom-resources')
const { FileSystem, AccessPoint } = require('aws-cdk-lib/aws-efs')
const { Bucket, BlockPublicAccess } = require('aws-cdk-lib/aws-s3')
const {
  ApplicationLoadBalancer,
  ApplicationProtocol,
} = require('aws-cdk-lib/aws-elasticloadbalancingv2')
const { NagSuppressions } = require('cdk-nag')

const dbInstance = {
  secret: {
    secretArn: '',
  }
}

const ENV = process.env.ENV

const VPCID = process.env.VPC_ID
if (!VPCID) {
  throw new Error('Please set the environment variable VPC_ID')
}

const graphNodeServiceStackName = `graph-node-service-stack-${process.env.ENV}`
const graphNodeClusterName = `graph-cluster-${process.env.ENV}`
const graphNodeClientRoleName = `graph-node-client-node-${ENV}`
const graphNodeTaskDefName = `graph-node-task-def-${ENV}`
// const createGraphNodeDBCustomResourceProviderName = `createGraphNodeDBCustomResourceProvider-${ENV}`
const createDBLambdaName = `create-graph-node-db-lambda-${ENV}`
const asgName = `graph-node-asg-${ENV}`
const dbSecretName = `graph-node-db-secret-${ENV}`
const ipfsContainerName = `ipfs${ENV}`

class GraphNodeCluster extends Construct {
  /**
   *
   * @param {cdk.Construct} scope
   * @param {string} id
   * @param {cdk.StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props)

    // Map from chainId to networkName
    const networkNames = new Map([
      [1, 'mainnet'],
      [3, 'ropsten'],
      [4, 'rinkeby'],
      [5, 'goerli'],
      [137, 'matic'],
      [80001, 'mumbai'],
      [11155111, 'sepolia'],
      [252, 'frax-mainnet'],
      [2522, 'frax-testnet']
    ])

    const networkName = networkNames.get(props.chainId)

    // use the default VPC
    // const vpc = Vpc.fromLookup(this, 'Vpc', { isDefault: true })
    const vpc = Vpc.fromLookup(this, 'Vpc', { vpcId: VPCID })

    // VPC Endpoint to SSM
    vpc.addInterfaceEndpoint(`secretsmanagerVPCE${ENV}`, {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    })

    // ALB SG open for queries from the internet to the ALB
    const albSg = new SecurityGroup(this, `alg-sg-${ENV}`, {
      vpc: vpc,
      description: `Graph Node ALB SG ${ENV}`,
      allowAllOutbound: true,
    })
    Tags.of(albSg).add('Name', `alg-sg-${ENV}`)

    // The Graph SG for ECS EC2 open for IPFS p2p communication and ALB SG
    const graphServiceSg = new SecurityGroup(this, `ec2-sg-${ENV}`, {
      vpc: vpc,
      description: `graph-node-sg-${ENV}`,
    })
    Tags.of(graphServiceSg).add('Name', `sg-${ENV}`)

    const dbName = `graph_node_${ENV}`

    // Aurora serverless
    // const dbEngine = DatabaseClusterEngine.auroraPostgres({
    //   version: AuroraPostgresEngineVersion.VER_15_5,
    // })
    // const dbParameterGroup = new ParameterGroup(this, `db-parameter-group-${ENV}`, {
    //   engine: dbEngine,
    //   parameters: {
    //     client_encoding: 'UTF8',
    //   },
    // })

    const dbSecret = new secretsmanager.Secret(this, dbSecretName, {
      secretObjectValue: {
        host: SecretValue.unsafePlainText(''),
        port: SecretValue.unsafePlainText('5432'),
        dbname: SecretValue.unsafePlainText(dbName),
        username: SecretValue.unsafePlainText(''),
        password: SecretValue.unsafePlainText(''),
      },
    })

    // const dbInstance = new DatabaseCluster(this, 'DbCluster', {
    //   engine: dbEngine,
    //   parameterGroup: dbParameterGroup,
    //   removalPolicy: RemovalPolicy.DESTROY,
    //   vpc,
    //   storageEncrypted: true,
    //   vpcSubnets: {
    //     availabilityZones: [
    //       Stack.of(this).availabilityZones[0],
    //       Stack.of(this).availabilityZones[1],
    //     ],
    //   },
    //   serverlessV2MinCapacity: 1,
    //   serverlessV2MaxCapacity: 2,
    //   writer: ClusterInstance.serverlessV2('dbWriter', {
    //     autoMinorVersionUpgrade: true,
    //     publiclyAccessible: false,
    //   }),
    //   // readers: [
    //   //   ClusterInstance.serverlessV2('dbReader', { scaleWithWriter: true }),
    //   // ],
    //   port: 5432, // postgres port
    // })

    const createDBLambda = new NodejsFunction(this, createDBLambdaName, {
      entry: path.join(__dirname, '../src/lambdas', 'dbCreation.js'),
      // projectRoot: path.join(__dirname, '..'),
      // depsLockFilePath: path.join(__dirname, '../package-lock.json'),
      bundling: {
        // bundleAwsSDK: true,
        // nodeModules: ['aws-sdk', 'pg-native'],
        externalModules: [
          '@aws-sdk/*',, // Use the 'aws-sdk' available in the Lambda runtime
          'pg-native',
        ],
        esbuildVersion: "0.21.0",
      },
      architecture: Architecture.X86_64,
      // logRetention: 1,//logs.RetentionDays.ONE_DAY,
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.minutes(3), // Default is 3 seconds
      memorySize: 256,
      vpc,
      allowPublicSubnet: true,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
        availabilityZones: [
          Stack.of(this).availabilityZones[0],
          Stack.of(this).availabilityZones[1],
        ],
      },
    })
    // dbInstance.secret.grantRead(createDBLambda)
    // dbInstance.connections.allowDefaultPortFrom(createDBLambda)

    // Define the custom resource
    // const createDBCustomResourceProvider = new Provider(
    //   this,
    //   createGraphNodeDBCustomResourceProviderName,
    //   {
    //     onEventHandler: createDBLambda,
    //     // logRetention: 1,
    //   }
    // )

    // const createDBCustomResource = new CustomResource(
    //   this,
    //   `createGraphNodeDBCustomResource${ENV}`,
    //   {
    //     serviceToken: createDBCustomResourceProvider.serviceToken,
    //     properties: {
    //       secretArn: dbSecret.secretArn,
    //       dbName: dbName,
    //     },
    //   }
    // )

    // Add a dependency to ensure that the custom resource runs after the cluster has been created
    // createDBCustomResource.node.addDependency(dbInstance)

    // ECS Cluster
    const cluster = new Cluster(this, `cluster-${ENV}`, {
      vpc: vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true
    })

    // Persistent volume: EFS
    const fileSystem = new FileSystem(this, `efs-${ENV}`, {
      vpc,
      removalPolicy: RemovalPolicy.DESTROY,
      encrypted: true,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
        availabilityZones: [
          Stack.of(this).availabilityZones[0],
          Stack.of(this).availabilityZones[1],
        ],
      },
    })

    fileSystem.addToResourcePolicy(
      new PolicyStatement({
        principals: [new AnyPrincipal()],
        actions: ['elasticfilesystem:ClientRootAccess'],
        resources: ['*'],
      })
    )

    const accessPoint = new AccessPoint(this, `volume-access-point-${ENV}`, {
      fileSystem: fileSystem,
      path: '/data/ipfs',
      createAcl: {
        ownerUid: '1000',
        ownerGid: '100',
        permissions: '755',
      },
      posixUser: {
        uid: '1000',
        gid: '100',
      },
    })

    const nodeClientRole = new Role(this, graphNodeClientRoleName, {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerServiceforEC2Role'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    })

    // const nodeClientLaunchTemplate = new LaunchTemplate(
    //   this,
    //   `graph-node-client-launch-template${ENV}`,
    //   {
    //     machineImage: EcsOptimizedImage.amazonLinux2(),
    //     instanceType: new InstanceType(props.graphInstanceType),
    //     securityGroup: graphServiceSg,
    //     userData: UserData.forLinux(),
    //     role: nodeClientRole,
    //     blockDevices: [
    //       {
    //         deviceName: '/dev/xvda',
    //         volume: BlockDeviceVolume.ebs(30, {
    //           encrypted: true,
    //           volumeType: EbsDeviceVolumeType.GP2,
    //         }),
    //       },
    //     ],
    //   }
    // )
    // fileSystem.connections.allowDefaultPortFrom(nodeClientLaunchTemplate)

    // const autoScalingGroup = new AutoScalingGroup(this, asgName, {
    //   vpc,
    //   vpcSubnets: {
    //     subnetType: SubnetType.PUBLIC,
    //     availabilityZones: [
    //       Stack.of(this).availabilityZones[0],
    //       Stack.of(this).availabilityZones[1],
    //     ],
    //   },
    //   launchTemplate: nodeClientLaunchTemplate,
    //   minCapacity: 1,
    //   maxCapacity: 1,
    // })

    nodeClientLaunchTemplate.connections.allowFrom(
      Peer.ipv4(`${props.allowedIP}/0`),
      Port.tcp(80),
      'graph queries from dev'
    )
    nodeClientLaunchTemplate.connections.allowFrom(
      Peer.ipv4(`${props.allowedIP}/0`),
      Port.tcp(8000),
      'graph queries from dev'
    )
    nodeClientLaunchTemplate.connections.allowFrom(
      Peer.ipv4(`${props.allowedIP}/0`),
      Port.tcp(8020),
      'graph deployment from dev'
    )
    nodeClientLaunchTemplate.connections.allowFrom(
      Peer.ipv4(`${props.allowedIP}/0`),
      Port.tcp(8030),
      'graph status queries from dev'
    )
    nodeClientLaunchTemplate.connections.allowFrom(
      Peer.ipv4(`${props.allowedIP}/0`),
      Port.tcp(5001),
      'IPFS deployment from dev'
    )

    nodeClientLaunchTemplate.connections.allowFrom(
      Peer.anyIpv4(),
      Port.tcp(4001),
      'IPFS P2P sync'
    )
    nodeClientLaunchTemplate.connections.allowFrom(
      Peer.anyIpv4(),
      Port.udp(4001),
      'IPFS P2P sync'
    )
    // dbInstance.connections.allowDefaultPortFrom(nodeClientLaunchTemplate)

    // const capacityProvider = new AsgCapacityProvider(this, 'capacity-provider', {
    //   autoScalingGroup: autoScalingGroup,
    //   capacityProviderName: cluster.cluster_name,
    //   enableManagedTerminationProtection: false,
    //   enableManagedScaling: false,
    // })

    // cluster.addAsgCapacityProvider(capacityProvider)

    const efsVolumeName = 'efsDataVolume'

    const taskDefinition = new FargateTaskDefinition(this, graphNodeTaskDefName, {
      networkMode: NetworkMode.AWS_VPC,
      volumes: [
        {
          name: efsVolumeName,
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: {
              accessPointId: accessPoint.accessPointId,
              iam: 'ENABLED',
            },
          },
        },
      ],
      cpu: 1024,
      memoryLimitMiB: 4096,
    })

    taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: [
          'elasticfilesystem:ClientRootAccess',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:DescribeMountTargets',
        ],
        resources: [fileSystem.fileSystemArn],
      })
    )

    // Creates IPFS Container
    const ipfsContainer = taskDefinition.addContainer(ipfsContainerName, {
      logging: LogDrivers.awsLogs({
        streamPrefix: 'IPFS',
        logRetention: 1,
      }),
      image: ContainerImage.fromRegistry('ipfs/kubo:v0.19.1'),
      memoryLimitMiB: 512,
      healthCheck: {
        command: [
          'CMD-SHELL',
          'ipfs dag stat /ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn || exit 1',
        ],
        interval: Duration.seconds(120),
        retries: 10,
      },
      portMappings: [
        {
          containerPort: 5001,
          hostPort: 5001,
          protocol: Protocol.TCP,
        },
        {
          containerPort: 4001,
          hostPort: 4001,
          protocol: Protocol.TCP,
        },
        {
          containerPort: 4001,
          hostPort: 4001,
          protocol: Protocol.UDP,
        },
      ],
    })

    // Mounts the host ipfs volume onto the ipfs container
    const ipfsMountPoint = {
      containerPath: '/data/ipfs',
      sourceVolume: efsVolumeName,
      readOnly: false,
    }
    ipfsContainer.addMountPoints(ipfsMountPoint)

    const environmentVars = {
      GRAPH_LOG: props.logLevel,
      ipfs: `127.0.0.1:5001`,
      ethereum: networkName + ':' + props.clientUrl,
      postgres_db: dbName,
    }

    // Creates Graph Node Container
    const graphnodeContainer = taskDefinition.addContainer(`graph-node-${ENV}`, {
      logging: LogDrivers.awsLogs({
        streamPrefix: `graph-node-${ENV}`,
        logRetention: 7,
      }),
      image: ContainerImage.fromRegistry('graphprotocol/graph-node:v0.35.1'),
      memoryLimitMiB: 3072,
      environment: environmentVars,
      healthCheck: {
        command: ["CMD-SHELL", "exit 0"],
        // command: ["CMD-SHELL", "curl --location 'http://localhost:8030/graphql' --header 'Content-Type: application/json' --data '{\"query\":\"{ indexingStatuses { health chains { network latestBlock {number}lastHealthyBlock { number } } } }\",\"variables\":{}}' || exit 1"],
        interval: Duration.seconds(300),
        retries: 10
      },
      secrets: {
        postgres_host: Secret.fromSecretsManager(dbSecret, 'host'),
        postgres_port: Secret.fromSecretsManager(dbSecret, 'port'),
        postgres_dbname: Secret.fromSecretsManager(dbSecret, 'dbname'),
        postgres_user: Secret.fromSecretsManager(dbSecret, 'username'),
        postgres_pass: Secret.fromSecretsManager(dbSecret, 'password'),
      },
      portMappings: [
        {
          containerPort: 8000,
          hostPort: 8000,
          protocol: Protocol.TCP,
        },
        {
          containerPort: 8001,
          hostPort: 8001,
          protocol: Protocol.TCP,
        },
        {
          containerPort: 8020,
          hostPort: 8020,
          protocol: Protocol.TCP,
        },
        {
          containerPort: 8030,
          hostPort: 8030,
          protocol: Protocol.TCP,
        },
        {
          containerPort: 8040,
          hostPort: 8040,
          protocol: Protocol.TCP,
        },
      ],
    })

    graphnodeContainer.addContainerDependencies({
      container: ipfsContainer,
      condition: ContainerDependencyCondition.HEALTHY,
    })

    // access log bucket
    const accessLogsBucket = new Bucket(this, `access-logs-${ENV}`, {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsPrefix: 'bucketaccesslogs/',
    })
    accessLogsBucket.grantPut(
      new ServicePrincipal('delivery.logs.amazonaws.com')
    )

    const service = new FargateService(this, `fargate-service-${ENV}`, {
      cluster: cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
        availabilityZones: [
          Stack.of(this).availabilityZones[0],
          Stack.of(this).availabilityZones[1],
        ],
      }
    })

    // service.node.addDependency(createDBCustomResource)

    const alb_port80 = new ApplicationLoadBalancer(this, `alb-port-80-${ENV}`, {
      vpc: vpc,
      internetFacing: false,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
        availabilityZones: [
          Stack.of(this).availabilityZones[0],
          Stack.of(this).availabilityZones[1],
        ],
      },
      dropInvalidHeaderFields: true,
    })
    alb_port80.connections.allowTo(
      graphServiceSg,
      Port.tcp(80),
      'GraphNode ALB for port 80'
    )

    const listener_port80 = alb_port80.addListener('Listener', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      open: false,
    })

    listener_port80.connections.addSecurityGroup(albSg)
    listener_port80.connections.allowInternally(Port.tcp(80), 'port80')

    const tg_p80 = listener_port80.addTargets(`ecs-${ENV}`, {
      port: 8000,
      protocol: ApplicationProtocol.HTTP,
      targets: [autoScalingGroup],
    })

    tg_p80.configureHealthCheck({
      path: '/',
      port: '8000',
      interval: Duration.seconds(120),
      unhealthyThresholdCount: 5,
    })

    alb_port80.logAccessLogs(accessLogsBucket, 'port80')

    const alb_port8030 = new ApplicationLoadBalancer(this, `alb-port-8030-${ENV}`, {
      vpc: vpc,
      internetFacing: false,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC,
        availabilityZones: [
          Stack.of(this).availabilityZones[0],
          Stack.of(this).availabilityZones[1],
        ],
      },
      dropInvalidHeaderFields: true,
    })

    alb_port8030.connections.allowTo(
      nodeClientLaunchTemplate,
      Port.tcp(8030),
      'ALB for port 8030'
    )

    const listener_port8030 = alb_port8030.addListener('Listener', {
      port: 8030,
      protocol: ApplicationProtocol.HTTP,
      open: false,
    })

    listener_port8030.connections.addSecurityGroup(albSg)
    listener_port8030.connections.allowInternally(Port.tcp(8030), 'port8030')

    const tg_p8030 = listener_port8030.addTargets(`ecs-${ENV}`, {
      port: 8030,
      protocol: ApplicationProtocol.HTTP,
      targets: [autoScalingGroup],
    })

    tg_p8030.configureHealthCheck({
      path: '/',
      port: '8030',
      interval: Duration.seconds(120),
      unhealthyThresholdCount: 5,
    })

    alb_port8030.logAccessLogs(accessLogsBucket, 'port8030')

    this.albListenerPort80 = listener_port80
    this.albListenerPort8030 = listener_port8030
    this.albPort80 = alb_port80
    this.albPort8030 = alb_port8030
    this.albSecurityGroup = albSg

    // cdk-nag suppressions
    NagSuppressions.addResourceSuppressions(graphServiceSg, [
      {
        id: 'AwsSolutions-EC23',
        reason: '[FP] graph node must sync IPFS data across internet via P2P',
      },
    ])

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${graphNodeServiceStackName}/${graphNodeClusterName}/${dbSecretName}/Resource`,
      [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            '[TP-N] secrets rotation disabled because application expects secrets in env vars',
        },
      ]
    )

    // NagSuppressions.addResourceSuppressionsByPath(
    //   this,
    //   '${graphNodeServiceStackName}/${graphNodeClusterName}/DbCluster/Resource',
    //   [
    //     {
    //       id: 'AwsSolutions-RDS6',
    //       reason:
    //         '[TP-C] Graph client does not support to retrieve token before DB access, compensation: Using Secrets Manager for user/password authentication',
    //     },
    //     {
    //       id: 'AwsSolutions-RDS10',
    //       reason: 'Disable deletion protection for DEV environment',
    //     },
    //   ]
    // )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        `${graphNodeServiceStackName}/${graphNodeClusterName}/${graphNodeClientRoleName}/DefaultPolicy/Resource`,
        // `/${graphNodeServiceStackName}/${graphNodeClusterName}/${createGraphNodeDBCustomResourceProviderName}/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
        `/${graphNodeServiceStackName}/${graphNodeClusterName}/${graphNodeClientRoleName}/DefaultPolicy/Resource`,
        `/${graphNodeServiceStackName}/${graphNodeClusterName}/${asgName}/DrainECSHook/Function/ServiceRole/DefaultPolicy/Resource`,
        // `/${graphNodeServiceStackName}/${graphNodeClusterName}/${asgName}/DrainECSHook/Function/ServiceRole/DefaultPolicy/Resource`,
      ],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '[TP-N] IAM role policy created by custom resource framework',
        },
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${graphNodeServiceStackName}/${graphNodeClusterName}/${asgName}/ASG`,
      [
        {
          id: 'AwsSolutions-AS3',
          reason:
            '[FP] No Auto Scaling Group notifications required for PoC-grade deployment',
        },
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        // `/${graphNodeServiceStackName}/${graphNodeClusterName}/${createGraphNodeDBCustomResourceProviderName}/framework-onEvent/ServiceRole/Resource`,
        `/${graphNodeServiceStackName}/${graphNodeClusterName}/${asgName}/DrainECSHook/Function/ServiceRole/Resource`,
        `/${graphNodeServiceStackName}/${graphNodeClusterName}/${graphNodeClientRoleName}/Resource`,
        `/${graphNodeServiceStackName}/${graphNodeClusterName}/${createDBLambdaName}/ServiceRole/Resource`,
      ],
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'roles created with minimal permissions by CDK',
        },
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        `${graphNodeServiceStackName}/${graphNodeClusterName}/${asgName}/DrainECSHook/Function/Resource`,
        // `${graphNodeServiceStackName}/${graphNodeClusterName}/${createGraphNodeDBCustomResourceProviderName}/framework-onEvent/Resource`,
      ],
      [
        {
          id: 'AwsSolutions-L1',
          reason:
            '[TP-C] lambda function autogenerated, using the latest CDK version',
        },
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${graphNodeServiceStackName}/${graphNodeClusterName}/${asgName}/LifecycleHookDrainHook/Topic/Resource`,
      [
        {
          id: 'AwsSolutions-SNS2',
          reason:
            '[FP] No server-side encryption needed for required for PoC-grade deployment',
        },
        {
          id: 'AwsSolutions-SNS3',
          reason: '[FP] No SSL encryption needed for PoC-grade deployment',
        },
      ]
    )

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${graphNodeServiceStackName}/${graphNodeClusterName}/${graphNodeTaskDefName}/Resource`,
      [
        {
          id: 'AwsSolutions-ECS2',
          reason:
            '[FP] only non-sensitive data are passed in as environment variables, secrets only via secrets',
        },
      ]
    )
  }
}

module.exports = { GraphNodeCluster }
