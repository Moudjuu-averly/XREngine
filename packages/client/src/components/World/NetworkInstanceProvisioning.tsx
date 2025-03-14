import { AppAction, GeneralStateList } from '@xrengine/client-core/src/common/services/AppService'
import { useLocationState } from '@xrengine/client-core/src/social/services/LocationService'
import { useAuthState } from '@xrengine/client-core/src/user/services/AuthService'
import { AuthService } from '@xrengine/client-core/src/user/services/AuthService'
import { UserService } from '@xrengine/client-core/src/user/services/UserService'
import { useUserState } from '@xrengine/client-core/src/user/services/UserService'
import { EngineEvents } from '@xrengine/engine/src/ecs/classes/EngineEvents'
import { InitializeOptions } from '@xrengine/engine/src/initializationOptions'
import { shutdownEngine } from '@xrengine/engine/src/initializeEngine'
import querystring from 'querystring'
import React, { useEffect } from 'react'
import { useDispatch } from '@xrengine/client-core/src/store'
import { retriveLocationByName } from './LocationLoadHelper'
import { useChatState } from '@xrengine/client-core/src/social/services/ChatService'
import { useInstanceConnectionState } from '@xrengine/client-core/src/common/services/InstanceConnectionService'
import { InstanceConnectionService } from '@xrengine/client-core/src/common/services/InstanceConnectionService'
import { ChannelConnectionService } from '@xrengine/client-core/src/common/services/ChannelConnectionService'
import { SocketWebRTCClientTransport } from '@xrengine/client-core/src/transports/SocketWebRTCClientTransport'
import { Network } from '@xrengine/engine/src/networking/classes/Network'
import { MessageTypes } from '@xrengine/engine/src/networking/enums/MessageTypes'
import { EngineActions, useEngineState } from '@xrengine/engine/src/ecs/classes/EngineService'
import { dispatchFrom, dispatchLocal } from '@xrengine/engine/src/networking/functions/dispatchFrom'
import { NetworkWorldAction } from '@xrengine/engine/src/networking/functions/NetworkWorldAction'
import { useWorld } from '@xrengine/engine/src/ecs/functions/SystemHooks'
import { Engine } from '@xrengine/engine/src/ecs/classes/Engine'

interface Props {
  locationName: string
}

export const NetworkInstanceProvisioning = (props: Props) => {
  const authState = useAuthState()
  const selfUser = authState.user
  const userState = useUserState()
  const dispatch = useDispatch()
  const chatState = useChatState()
  const locationState = useLocationState()
  const instanceConnectionState = useInstanceConnectionState()
  const isUserBanned = locationState.currentLocation.selfUserBanned.value
  const engineState = useEngineState()

  // 1. Ensure api server connection in and set up reset listener
  useEffect(() => {
    AuthService.doLoginAuto(true)
    EngineEvents.instance.addEventListener(EngineEvents.EVENTS.RESET_ENGINE, async (ev: any) => {
      if (!ev.instance) return

      await shutdownEngine()
      InstanceConnectionService.resetInstanceServer()

      if (!isUserBanned) {
        retriveLocationByName(authState, props.locationName, history)
      }
    })
  }, [])

  // 2. once we have the location, provision the instance server
  useEffect(() => {
    const currentLocation = locationState.currentLocation.location
    console.log('locationState.currentLocation.location.value', locationState.currentLocation.location.value)

    if (currentLocation.id?.value) {
      if (
        !isUserBanned &&
        !instanceConnectionState.instanceProvisioned.value &&
        !instanceConnectionState.instanceProvisioning.value
      ) {
        const search = window.location.search
        let instanceId

        if (search != null) {
          const parsed = new URL(window.location.href).searchParams.get('instanceId')
          instanceId = parsed
        }

        InstanceConnectionService.provisionInstanceServer(
          currentLocation.id.value,
          instanceId || undefined,
          locationState.currentLocation.location.sceneId.value
        )
      }
    } else {
      if (!locationState.currentLocationUpdateNeeded.value && !locationState.fetchingCurrentLocation.value) {
        dispatch(AppAction.setAppSpecificOnBoardingStep(GeneralStateList.FAILED, false))
      }
    }
  }, [locationState.currentLocation.location.value])

  // 3. once engine is initialised and the server is provisioned, connect the the instance server
  useEffect(() => {
    if (
      engineState.isInitialised.value &&
      !instanceConnectionState.connected.value &&
      instanceConnectionState.instanceProvisioned.value &&
      !instanceConnectionState.instanceServerConnecting.value
    )
      InstanceConnectionService.connectToInstanceServer('instance')
    console.log('connect to instance server')
  }, [
    engineState.isInitialised.value,
    instanceConnectionState.connected.value,
    instanceConnectionState.instanceServerConnecting.value,
    instanceConnectionState.instanceProvisioned.value
  ])

  useEffect(() => {
    console.log(
      'instanceConnectionState.connected.value && engineState.sceneLoaded.value',
      engineState.connectedWorld.value,
      engineState.sceneLoaded.value
    )
    if (engineState.connectedWorld.value && engineState.sceneLoaded.value) {
      // TEMPORARY - just so portals work for now - will be removed in favor of gameserver-gameserver communication
      ;(Network.instance.transport as SocketWebRTCClientTransport)
        .instanceRequest(MessageTypes.JoinWorld.toString())
        .then(({ tick, clients, cachedActions, spawnPose, avatarDetail }) => {
          console.log('RECEIVED JOIN WORLD RESPONSE')
          dispatchLocal(EngineActions.joinedWorld(true) as any)
          useWorld().fixedTick = tick
          const hostId = useWorld().hostId
          for (const client of clients)
            Engine.currentWorld.incomingActions.add(
              NetworkWorldAction.createClient({ $from: client.userId, name: client.name })
            )
          for (const action of cachedActions) Engine.currentWorld.incomingActions.add({ $fromCache: true, ...action })

          if (engineState.isTeleporting.value) {
            spawnPose = {
              position: engineState.isTeleporting.value.remoteSpawnPosition,
              rotation: engineState.isTeleporting.value.remoteSpawnRotation
            }
          }

          dispatchFrom(Engine.userId, () =>
            NetworkWorldAction.spawnAvatar({
              parameters: { ...spawnPose }
            })
          ).cache()

          dispatchFrom(Engine.userId, () => NetworkWorldAction.avatarDetails({ avatarDetail })).cache({
            removePrevious: true
          })
        })
    }
  }, [engineState.connectedWorld.value, engineState.sceneLoaded.value])

  useEffect(() => {
    if (engineState.joinedWorld.value) {
      if (engineState.isTeleporting.value) dispatchLocal(EngineActions.setTeleporting(null!))
      dispatch(AppAction.setAppOnBoardingStep(GeneralStateList.SUCCESS))
      dispatch(AppAction.setAppLoaded(true))
    }
  }, [engineState.joinedWorld.value])

  // channel server provisioning (if needed)
  useEffect(() => {
    if (chatState.instanceChannelFetched.value) {
      const channels = chatState.channels.channels.value
      const instanceChannel = Object.values(channels).find(
        (channel) => channel.instanceId === instanceConnectionState.instance.id.value
      )
      ChannelConnectionService.provisionChannelServer(instanceChannel?.id)
    }
  }, [chatState.instanceChannelFetched.value])

  // periodically listening for users spatially near
  useEffect(() => {
    if (selfUser?.instanceId.value != null && userState.layerUsersUpdateNeeded.value) UserService.getLayerUsers(true)
  }, [selfUser, userState.layerUsersUpdateNeeded.value])

  // ? maybe unneeded
  useEffect(() => {
    if (
      instanceConnectionState.instanceProvisioned.value &&
      instanceConnectionState.updateNeeded.value &&
      !instanceConnectionState.instanceServerConnecting.value &&
      !instanceConnectionState.connected.value
    ) {
      // TODO: fix up reinitialisation - we need to handle this more gently
      // reinit()
    }
  }, [instanceConnectionState])

  return <></>
}

export default NetworkInstanceProvisioning
