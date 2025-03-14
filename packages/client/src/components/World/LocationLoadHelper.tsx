import { GeneralStateList, AppAction } from '@xrengine/client-core/src/common/services/AppService'
import { client } from '@xrengine/client-core/src/feathers'
import { Config } from '@xrengine/common/src/config'
import { LocationService } from '@xrengine/client-core/src/social/services/LocationService'
import { store, useDispatch } from '@xrengine/client-core/src/store'
import { getPortalDetails } from '@xrengine/client-core/src/world/functions/getPortalDetails'
import { testScenes } from '@xrengine/common/src/assets/testScenes'
import { Engine } from '@xrengine/engine/src/ecs/classes/Engine'
import { EngineEvents } from '@xrengine/engine/src/ecs/classes/EngineEvents'
import { InitializeOptions } from '@xrengine/engine/src/initializationOptions'
import { initializeEngine } from '@xrengine/engine/src/initializeEngine'
import { Network } from '@xrengine/engine/src/networking/classes/Network'
import { loadSceneFromJSON } from '@xrengine/engine/src/scene/functions/SceneLoading'
import { SocketWebRTCClientTransport } from '@xrengine/client-core/src/transports/SocketWebRTCClientTransport'
import { Vector3, Quaternion } from 'three'
import { getSystemsFromSceneData } from '@xrengine/projects/loader'
import { UserId } from '@xrengine/common/src/interfaces/UserId'
import { useWorld } from '@xrengine/engine/src/ecs/functions/SystemHooks'
import { NetworkWorldAction } from '@xrengine/engine/src/networking/functions/NetworkWorldAction'
import { dispatchLocal } from '@xrengine/engine/src/networking/functions/dispatchFrom'
import { SceneJson } from '@xrengine/common/src/interfaces/SceneInterface'
import { EngineActions } from '@xrengine/engine/src/ecs/classes/EngineService'

export const retriveLocationByName = (authState: any, locationName: string, history: any) => {
  if (
    authState.isLoggedIn?.value === true &&
    authState.user?.id?.value != null &&
    authState.user?.id?.value.length > 0
  ) {
    if (locationName === Config.publicRuntimeConfig.lobbyLocationName) {
      LocationService.getLobby()
        .then((lobby) => {
          history.replace('/location/' + lobby.slugifiedName)
        })
        .catch((err) => console.log('getLobby error', err))
    } else {
      LocationService.getLocationByName(locationName)
    }
  }
}

export const getSceneData = async (projectName: string, sceneName: string, isOffline: boolean) => {
  if (isOffline) {
    return testScenes[sceneName] || testScenes.test
  }

  const sceneResult = await client.service('scene').get({ projectName, sceneName })
  console.log(sceneResult)
  return sceneResult.data.scene
}

const getFirstSpawnPointFromSceneData = (scene: SceneJson) => {
  for (const entity of Object.values(scene.entities)) {
    if (entity.name != 'spawn point') continue

    for (const component of entity.components) {
      if (component.name === 'transform') {
        return component.props.position
      }
    }
  }

  console.warn('Could not find spawn point from scene data')
  return { x: 0, y: 0, z: 0 }
}

const createOfflineUser = (sceneData: SceneJson) => {
  const avatarDetail = {
    thumbnailURL: '',
    avatarURL: ''
  } as any

  const spawnPos = getFirstSpawnPointFromSceneData(sceneData)

  const userId = 'user' as UserId
  const parameters = {
    position: new Vector3().copy(spawnPos),
    rotation: new Quaternion()
  }

  const world = useWorld()
  world.hostId = userId as any

  // it is needed by AvatarSpawnSystem
  Engine.userId = userId
  // Replicate the server behavior
  dispatchLocal(NetworkWorldAction.createClient({ name: 'user' }) as any)
  dispatchLocal(NetworkWorldAction.spawnAvatar({ parameters }) as any)
  dispatchLocal(NetworkWorldAction.avatarDetails({ avatarDetail }) as any)
}

export const initEngine = async (initOptions: InitializeOptions) => {
  Engine.isLoading = true
  Network.instance.transport = new SocketWebRTCClientTransport()
  await initializeEngine(initOptions)
}

export const loadLocation = async (sceneName: string): Promise<any> => {
  console.log('loading location: ' + sceneName)
  const [project, scene] = sceneName.split('/')

  // 1. Get scene data
  const sceneData = await getSceneData(project, scene, false)

  const packs = await getSystemsFromSceneData(project, sceneData, true)

  await Engine.currentWorld.initSystems(packs)
  const dispatch = useDispatch()

  // 4. Start scene loading
  dispatch(AppAction.setAppOnBoardingStep(GeneralStateList.SCENE_LOADING))

  const onEntityLoaded = ({ entitiesLeft }) => {
    dispatchLocal(EngineActions.loadingProgress(entitiesLeft) as any)
  }
  EngineEvents.instance.addEventListener(EngineEvents.EVENTS.SCENE_ENTITY_LOADED, onEntityLoaded)
  await loadSceneFromJSON(sceneData)
  EngineEvents.instance.removeEventListener(EngineEvents.EVENTS.SCENE_ENTITY_LOADED, onEntityLoaded)

  getPortalDetails()
  dispatch(AppAction.setAppOnBoardingStep(GeneralStateList.SCENE_LOADED))
  Engine.isLoading = false
}
